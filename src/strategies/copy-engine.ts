import { NansenHyperliquidClient } from '../nansen/hyperliquid-client';
import { OnchainOsHyperliquidClient } from '../onchainos/hyperliquid-client';
import { PerpSide } from '../nansen/hyperliquid-types';
import { TraderProfiler, TraderProfile, NewTraderMove, Timeframe } from './trader-profiler';
import { MarketAnalyzer, MarketCondition } from './market-analyzer';
import { MarketRegimeDetector, RegimeAnalysis } from './regime-detector';
import { EntryQualityEstimator, EntryQuality } from './entry-quality';
import { RiskManager, RiskLevel, ActivePosition } from './risk-manager';
import { PortfolioTracker } from './portfolio-tracker';
import { AppConfig } from '../config';
import { logger } from '../utils/logger';
import { formatUsd, sleep } from '../utils/formatting';

/**
 * Smart Money Copy Engine — The main copy-trading loop.
 *
 * This is NOT blind copy trading. The engine:
 * 1. Profiles SM traders → ranks by PnL, win rate, consistency
 * 2. Watches for new moves from S/A tier traders only
 * 3. Before copying: runs full market analysis (7 indicators)
 * 4. Only executes when: top trader + market confirms
 * 5. Manages positions: SL/TP/trailing stop + sentiment monitoring
 *
 * Flow:
 *   Trader Profiler → leaderboard → watch S/A tier
 *     → new move detected → Market Analyzer validates
 *       → ✅ confirmed → execute copy trade via OnchainOS
 *       → ❌ rejected → skip (log why)
 */

export interface CopyEngineConfig {
  scanIntervalMinutes: number;       // how often to check for new moves (default: 3)
  leaderboardRefreshMinutes: number; // rebuild leaderboard every N min (default: 30)
  timeframe: Timeframe;              // 24h | 7d | 30d
  topTradersToWatch: number;         // only watch top N traders (default: 10)
  minTraderScore: number;            // min score to follow (default: 50)
  minMarketConfirmation: number;     // min market composite score to proceed (default: 0.1)
  riskLevel: RiskLevel;
  maxTradeSizeUsd: number;
  sizeMultiplier: number;            // multiply trader's % position by this (default: 0.5)
}

export interface CopyDecision {
  move: NewTraderMove;
  marketCondition: MarketCondition;
  decision: 'copy' | 'skip';
  reason: string;
  sizeUsd: number;
  leverage: number;
}

export interface CopyCycleResult {
  cycleNumber: number;
  timestamp: string;
  leaderboardSize: number;
  movesDetected: number;
  decisions: CopyDecision[];
  tradesExecuted: string[];
  positionsClosed: string[];
  errors: string[];
}

type EngineState = 'idle' | 'running' | 'stopped';

export class SmartMoneyCopyEngine {
  private nansenHL: NansenHyperliquidClient;
  private onchainHL: OnchainOsHyperliquidClient;
  private profiler: TraderProfiler;
  private analyzer: MarketAnalyzer;
  private regimeDetector: MarketRegimeDetector;
  private entryEstimator: EntryQualityEstimator;
  private risk: RiskManager;
  private portfolio: PortfolioTracker;
  private config: CopyEngineConfig;

  private state: EngineState = 'idle';
  private cycleCount = 0;
  private leaderboard: TraderProfile[] = [];
  private lastLeaderboardRefresh = 0;
  private activePositions: ActivePosition[] = [];
  private copiedMoves = new Set<string>(); // "address:token:side" to avoid duplicate copies
  private onCycleComplete?: (result: CopyCycleResult) => void;

  constructor(
    nansenHL: NansenHyperliquidClient,
    onchainHL: OnchainOsHyperliquidClient,
    appConfig: AppConfig,
    overrides?: Partial<CopyEngineConfig>,
  ) {
    this.nansenHL = nansenHL;
    this.onchainHL = onchainHL;

    this.config = {
      scanIntervalMinutes: overrides?.scanIntervalMinutes ?? 3,
      leaderboardRefreshMinutes: overrides?.leaderboardRefreshMinutes ?? 30,
      timeframe: overrides?.timeframe ?? '7d',
      topTradersToWatch: overrides?.topTradersToWatch ?? 10,
      minTraderScore: overrides?.minTraderScore ?? 50,
      minMarketConfirmation: overrides?.minMarketConfirmation ?? 0.1,
      riskLevel: overrides?.riskLevel ?? (appConfig.agent.riskLevel as RiskLevel) ?? 'medium',
      maxTradeSizeUsd: overrides?.maxTradeSizeUsd ?? appConfig.agent.maxTradeSizeUsd ?? 500,
      sizeMultiplier: overrides?.sizeMultiplier ?? 0.5,
    };

    this.profiler = new TraderProfiler(nansenHL);
    this.analyzer = new MarketAnalyzer(nansenHL);
    this.regimeDetector = new MarketRegimeDetector(nansenHL);
    this.entryEstimator = new EntryQualityEstimator();
    this.risk = new RiskManager(this.config.riskLevel, {
      maxPerTradeUsd: this.config.maxTradeSizeUsd,
    });
    this.portfolio = new PortfolioTracker();
  }

  onCycle(cb: (result: CopyCycleResult) => void): void {
    this.onCycleComplete = cb;
  }

  /** Start the copy engine loop */
  async start(): Promise<void> {
    if (this.state === 'running') return;
    this.state = 'running';

    logger.signal('Copy Engine STARTED');
    logger.info(`Config: scan every ${this.config.scanIntervalMinutes}m | timeframe: ${this.config.timeframe} | risk: ${this.config.riskLevel}`);
    logger.info(`Watching top ${this.config.topTradersToWatch} traders | min score: ${this.config.minTraderScore} | market confirmation: ${this.config.minMarketConfirmation}`);

    // Restore open positions
    this.syncOpenPositions();

    while (this.state === 'running') {
      try {
        const result = await this.runCycle();
        this.onCycleComplete?.(result);
      } catch (err) {
        logger.error(`Cycle error: ${err}`);
      }

      if (this.state === 'running') {
        await sleep(this.config.scanIntervalMinutes * 60_000);
      }
    }

    logger.signal('Copy Engine STOPPED');
  }

  stop(): void { this.state = 'stopped'; }
  getState(): EngineState { return this.state; }
  getPortfolio(): PortfolioTracker { return this.portfolio; }
  getRiskManager(): RiskManager { return this.risk; }
  getLeaderboard(): TraderProfile[] { return [...this.leaderboard]; }
  getActivePositions(): ActivePosition[] { return [...this.activePositions]; }

  // ─── Core Cycle ─────────────────────────────────────────────────────────────

  async runCycle(): Promise<CopyCycleResult> {
    this.cycleCount++;
    const result: CopyCycleResult = {
      cycleNumber: this.cycleCount,
      timestamp: new Date().toISOString(),
      leaderboardSize: 0,
      movesDetected: 0,
      decisions: [],
      tradesExecuted: [],
      positionsClosed: [],
      errors: [],
    };

    logger.info(`── Copy Cycle #${this.cycleCount} ──────────────────────────────`);

    // ─── Phase 0: Check global market regime ────────────────────────────────
    // Should we trade at ALL in this cycle?
    let globalRegime: RegimeAnalysis | null = null;
    try {
      globalRegime = await this.regimeDetector.detectGlobalRegime();
      logger.info(`Regime: ${globalRegime.regime} (vol ${globalRegime.volatilityPct.toFixed(1)}%) — ${globalRegime.reasoning}`);
    } catch (err) {
      result.errors.push(`Regime: ${err}`);
    }

    // ─── Phase 0b: Check adaptive performance adjustments ────────────────────
    const adaptive = this.portfolio.getAdaptiveAdjustments();
    if (adaptive.minScoreBoost > 0 || adaptive.shouldPause) {
      logger.info(`Adaptive: ${adaptive.reasoning}`);
    }
    if (adaptive.shouldPause) {
      logger.warn('ADAPTIVE PAUSE: Recent performance too poor — skipping new entries');
    }

    // ─── Phase 1: Refresh leaderboard if needed ─────────────────────────────
    await this.refreshLeaderboard(result);
    result.leaderboardSize = this.leaderboard.length;

    // ─── Phase 2: Check existing positions for exits ────────────────────────
    await this.checkExistingPositions(result);

    // ─── Phase 3: Detect new moves from top traders ─────────────────────────
    const shouldScanNewMoves = !adaptive.shouldPause &&
      (!globalRegime || globalRegime.shouldTrade);

    let moves: NewTraderMove[] = [];
    if (shouldScanNewMoves) {
      moves = await this.detectAndFilterMoves(result);
    }
    result.movesDetected = moves.length;

    // ─── Phase 4: Analyze market + decide for each move ─────────────────────
    for (const move of moves) {
      try {
        const decision = await this.evaluateMove(move, globalRegime, adaptive);
        result.decisions.push(decision);

        if (decision.decision === 'copy') {
          const executed = await this.executeCopy(decision, globalRegime);
          if (executed) {
            result.tradesExecuted.push(`${move.token} ${move.side}`);
          }
        } else {
          logger.info(`SKIP ${move.trader.label.slice(0, 15)} ${move.side} ${move.token}: ${decision.reason}`);
        }
      } catch (err) {
        result.errors.push(`Evaluate ${move.token}: ${err}`);
      }
    }

    // ─── Phase 5: Summary ───────────────────────────────────────────────────
    const stats = this.portfolio.getStats();
    logger.info(
      `Cycle #${this.cycleCount}: ${moves.length} moves detected, ` +
      `${result.tradesExecuted.length} copied, ${result.positionsClosed.length} closed | ` +
      `PnL: ${formatUsd(stats.totalPnlUsd)} WR: ${stats.winRate.toFixed(0)}%`
    );

    return result;
  }

  // ─── Phase 1: Leaderboard ──────────────────────────────────────────────────

  private async refreshLeaderboard(result: CopyCycleResult): Promise<void> {
    const elapsed = Date.now() - this.lastLeaderboardRefresh;
    if (this.leaderboard.length > 0 && elapsed < this.config.leaderboardRefreshMinutes * 60_000) {
      return; // Still fresh
    }

    try {
      logger.info(`Building trader leaderboard (${this.config.timeframe})...`);
      this.leaderboard = await this.profiler.getLeaderboard(
        this.config.timeframe,
        this.config.topTradersToWatch * 2 // fetch more, filter by score
      );

      // Filter by min score
      this.leaderboard = this.leaderboard.filter(t => t.score >= this.config.minTraderScore);

      // Keep only top N
      this.leaderboard = this.leaderboard.slice(0, this.config.topTradersToWatch);

      this.lastLeaderboardRefresh = Date.now();

      if (this.leaderboard.length > 0) {
        logger.info(`Watching ${this.leaderboard.length} traders:`);
        for (const t of this.leaderboard.slice(0, 5)) {
          logger.info(`  [${t.tier}] ${t.label.slice(0, 20)} — score ${t.score}, PnL ${formatUsd(t.totalPnlUsd)}, WR ${t.winRate.toFixed(0)}%, ${t.openPositions.length} open`);
        }
      } else {
        logger.warn('No traders found meeting minimum score');
      }
    } catch (err) {
      result.errors.push(`Leaderboard: ${err}`);
    }
  }

  // ─── Phase 2: Position Management ──────────────────────────────────────────

  private async checkExistingPositions(result: CopyCycleResult): Promise<void> {
    if (this.activePositions.length === 0) return;

    const toClose: { pos: ActivePosition; reason: string }[] = [];

    for (const pos of this.activePositions) {
      try {
        // Re-check sentiment
        const sentiment = await this.nansenHL.getSmartMoneySentiment(pos.token);

        // Get current price
        const markPrice = await this.getCurrentPrice(pos.token);
        const pnlPct = pos.side === 'Long'
          ? ((markPrice - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage
          : ((pos.entryPrice - markPrice) / pos.entryPrice) * 100 * pos.leverage;

        pos.currentPnlPct = pnlPct;

        // Check if the source trader we copied has exited
        const traderExited = await this.checkTraderExited(pos);

        // Sentiment flipped?
        const sentimentFlipped = (pos.side === 'Long' &&
          (sentiment.signal === 'strong_short' || sentiment.signal === 'lean_short'))
          || (pos.side === 'Short' &&
            (sentiment.signal === 'strong_long' || sentiment.signal === 'lean_long'));

        const closeCheck = this.risk.shouldClosePosition(pos, pnlPct, sentimentFlipped);

        // Also close if source trader exited
        if (traderExited) {
          toClose.push({ pos, reason: 'Source trader exited position' });
        } else if (closeCheck.close) {
          toClose.push({ pos, reason: closeCheck.reason });
        }
      } catch (err) {
        result.errors.push(`Check ${pos.token}: ${err}`);
      }
    }

    for (const { pos, reason } of toClose) {
      await this.closePosition(pos, reason, result);
    }
  }

  private async checkTraderExited(pos: ActivePosition): Promise<boolean> {
    // The tradeId format is "copy-{traderAddr}-{timestamp}"
    // We can extract the trader address to check
    const parts = pos.tradeId.split('-');
    if (parts.length < 3 || parts[0] !== 'copy') return false;
    const traderAddr = parts[1];

    try {
      const posRes = await this.nansenHL.getAddressPerpPositions({
        address: traderAddr,
        filters: { token_symbol: pos.token, position_type: pos.side },
      });

      // If trader no longer has this position, they exited
      return posRes.data.length === 0;
    } catch {
      return false; // Can't verify, assume still in
    }
  }

  private async closePosition(pos: ActivePosition, reason: string, result: CopyCycleResult): Promise<void> {
    try {
      logger.signal(`CLOSING ${pos.side} ${pos.token}: ${reason}`);

      await this.onchainHL.closePosition({
        token_symbol: pos.token,
        side: pos.side,
      });

      const markPrice = await this.getCurrentPrice(pos.token);
      this.portfolio.recordExit(pos.tradeId, markPrice, reason);
      this.risk.recordTrade(pos.token);

      // Remove from copiedMoves to allow re-copy later
      const moveKey = `${pos.tradeId.split('-')[1]}:${pos.token}:${pos.side}`;
      this.copiedMoves.delete(moveKey);

      this.activePositions = this.activePositions.filter(p => p.tradeId !== pos.tradeId);
      result.positionsClosed.push(`${pos.token}:${reason}`);
    } catch (err) {
      result.errors.push(`Close ${pos.token}: ${err}`);
    }
  }

  // ─── Phase 3: Move Detection ───────────────────────────────────────────────

  private async detectAndFilterMoves(result: CopyCycleResult): Promise<NewTraderMove[]> {
    if (this.leaderboard.length === 0) return [];

    try {
      const moves = await this.profiler.detectNewMoves(this.leaderboard);

      // Filter out already-copied moves and moves on tokens we already hold
      return moves.filter(m => {
        const key = `${m.trader.address}:${m.token}:${m.side}`;
        if (this.copiedMoves.has(key)) return false;
        if (this.activePositions.some(p => p.token === m.token)) return false;
        return true;
      });
    } catch (err) {
      result.errors.push(`Detect moves: ${err}`);
      return [];
    }
  }

  // ─── Phase 4: Move Evaluation ──────────────────────────────────────────────

  private async evaluateMove(
    move: NewTraderMove,
    globalRegime: RegimeAnalysis | null,
    adaptive: ReturnType<PortfolioTracker['getAdaptiveAdjustments']>,
  ): Promise<CopyDecision> {
    logger.info(`Evaluating: ${move.trader.label.slice(0, 15)} [${move.trader.tier}] ${move.side} ${move.token} ${formatUsd(move.sizeUsd)}`);

    // ─── Gate 1: Trader quality ─────────────────────────────────
    if (move.trader.tier === 'C') {
      return this.skipDecision(move, `Trader tier too low (${move.trader.tier}, score ${move.trader.score})`);
    }
    if (move.trader.isLikelyHedger) {
      return this.skipDecision(move, `Trader likely hedging (risk ${(move.trader.hedgingRisk*100).toFixed(0)}%) — copying isolated leg is dangerous`);
    }
    if (move.trader.dependsOnSingleWin) {
      return this.skipDecision(move, `Trader PnL depends on single position — could be luck`);
    }

    // ─── Gate 2: Correlation check ──────────────────────────────
    const correlation = MarketRegimeDetector.checkCorrelationRisk(
      move.token,
      move.side,
      this.activePositions.map(p => ({ token: p.token, side: p.side, sizeUsd: p.sizeUsd })),
    );
    if (correlation.excessive) {
      return this.skipDecision(move,
        `Correlation risk: already have ${correlation.existingCorrelated.join(',')} in '${correlation.group}' group same direction`
      );
    }

    // ─── Gate 3: Entry quality (slippage check) ─────────────────
    const currentPrice = await this.getCurrentPrice(move.token);
    const leverage = this.risk.computeLeverage(move.trader.score);

    // Get volatility for dynamic SL calculation
    let tokenVol = 3; // default
    try {
      const vol = await this.regimeDetector.estimateVolatility(move.token);
      tokenVol = vol.dailyRangePct;
    } catch { /* use default */ }

    const dynamicSL = MarketRegimeDetector.computeDynamicStopLoss(
      this.risk.config.stopLossPct,
      tokenVol,
      leverage,
    );

    const entryQuality = this.entryEstimator.estimate(
      move.token, move.side, move.price, currentPrice, leverage, dynamicSL,
    );

    if (!entryQuality.shouldEnter) {
      return this.skipDecision(move, `Entry quality: ${entryQuality.reason}`);
    }

    // ─── Gate 4: Market analysis ────────────────────────────────
    const market = await this.analyzer.analyze(move.token, move.side);

    for (const line of market.reasoning) {
      logger.debug(`  ${line}`);
    }

    if (market.verdict === 'strong_reject' || market.verdict === 'reject') {
      return {
        move, marketCondition: market, decision: 'skip',
        reason: `Market rejects ${move.side}: ${market.verdict} (${market.confirmsPct}% confirm)`,
        sizeUsd: 0, leverage: 0,
      };
    }

    // Apply adaptive adjustment to market threshold
    const effectiveMinMarket = this.config.minMarketConfirmation +
      (adaptive.minScoreBoost / 100); // convert score boost to market score shift

    if (market.compositeScore < effectiveMinMarket) {
      return {
        move, marketCondition: market, decision: 'skip',
        reason: `Market score ${market.compositeScore} < effective min ${effectiveMinMarket.toFixed(2)} (adaptive: +${adaptive.minScoreBoost})`,
        sizeUsd: 0, leverage: 0,
      };
    }

    // ─── Compute position size ──────────────────────────────────
    // Use risk-based sizing: constant $ risk per trade, not constant $ size
    let sizeUsd = MarketRegimeDetector.computeRiskBasedSize(
      this.config.maxTradeSizeUsd,
      5, // risk 5% of max per trade
      dynamicSL,
      leverage,
    );

    // Apply regime multiplier
    if (globalRegime) {
      sizeUsd = Math.round(sizeUsd * globalRegime.sizeMultiplier);
    }

    // Apply adaptive multiplier
    sizeUsd = Math.round(sizeUsd * adaptive.sizeMultiplier);

    // Apply entry quality multiplier
    sizeUsd = Math.round(sizeUsd * this.entryEstimator.getSizeMultiplier(entryQuality.quality));

    // ─── Final risk check ───────────────────────────────────────
    const riskCheck = this.risk.canOpenPosition(
      move.token, sizeUsd, move.trader.score,
      this.activePositions, 0,
    );

    if (!riskCheck.allowed) {
      return {
        move, marketCondition: market, decision: 'skip',
        reason: `Risk: ${riskCheck.reason}`,
        sizeUsd: 0, leverage: 0,
      };
    }

    // ─── All gates passed: COPY ─────────────────────────────────
    return {
      move,
      marketCondition: market,
      decision: 'copy',
      reason: `[${move.trader.tier}] (score ${move.trader.score}) + market ${market.verdict} (${market.confirmsPct}%) + entry ${entryQuality.quality} + regime ${globalRegime?.regime ?? '?'} | size ${formatUsd(sizeUsd)} @ ${leverage}x (SL ${dynamicSL}%)`,
      sizeUsd,
      leverage,
    };
  }

  private skipDecision(move: NewTraderMove, reason: string): CopyDecision {
    return {
      move,
      marketCondition: {
        token: move.token, side: move.side, timestamp: new Date(),
        indicators: {} as any, compositeScore: 0, confirmsPct: 0,
        verdict: 'neutral', reasoning: [],
      },
      decision: 'skip', reason, sizeUsd: 0, leverage: 0,
    };
  }

  // ─── Phase 5: Execution ────────────────────────────────────────────────────

  private async executeCopy(decision: CopyDecision, globalRegime: RegimeAnalysis | null): Promise<boolean> {
    const { move, sizeUsd, leverage } = decision;

    try {
      logger.signal(
        `COPY ${move.side} ${move.token} — following ${move.trader.label.slice(0, 15)} [${move.trader.tier}] | ` +
        `size ${formatUsd(sizeUsd)} @ ${leverage}x | ` +
        `market: ${decision.marketCondition.verdict} (${decision.marketCondition.confirmsPct}% confirm)`
      );

      // Set leverage
      await this.onchainHL.setLeverage({
        token_symbol: move.token,
        leverage,
        leverage_type: 'Cross',
      });

      // Place order
      const orderResult = await this.onchainHL.placeOrder({
        token_symbol: move.token,
        side: move.side,
        order_type: 'Market',
        size_usd: sizeUsd,
        leverage,
        slippage_pct: 1,
      });

      const tradeId = `copy-${move.trader.address.slice(0, 10)}-${Date.now()}`;
      const entryPrice = orderResult.avg_fill_price || move.price;

      // Track position
      this.activePositions.push({
        token: move.token,
        side: move.side,
        entryPrice,
        sizeUsd,
        leverage,
        entryTime: new Date(),
        peakPnlPct: 0,
        currentPnlPct: 0,
        signalScore: move.trader.score,
        tradeId,
      });

      this.portfolio.recordEntry({
        id: tradeId,
        token: move.token,
        side: move.side,
        sizeUsd,
        leverage,
        entryPrice,
        entryTime: new Date().toISOString(),
        signalScore: move.trader.score,
        fees: orderResult.fee_usd,
      });

      // Mark as copied
      const key = `${move.trader.address}:${move.token}:${move.side}`;
      this.copiedMoves.add(key);
      this.risk.recordTrade(move.token);

      return true;
    } catch (err) {
      logger.error(`Failed to copy ${move.token}: ${err}`);
      return false;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async getCurrentPrice(token: string): Promise<number> {
    try {
      const res = await this.nansenHL.screenPerps({
        date: {
          from: new Date(Date.now() - 3_600_000).toISOString(),
          to: new Date().toISOString(),
        },
        filters: { token_symbol: token },
        pagination: { page: 1, per_page: 1 },
      });
      return res.data[0]?.mark_price ?? 0;
    } catch {
      return 0;
    }
  }

  private syncOpenPositions(): void {
    const openTrades = this.portfolio.getOpenTrades();
    for (const trade of openTrades) {
      if (!this.activePositions.some(p => p.tradeId === trade.id)) {
        this.activePositions.push({
          token: trade.token,
          side: trade.side,
          entryPrice: trade.entryPrice,
          sizeUsd: trade.sizeUsd,
          leverage: trade.leverage,
          entryTime: new Date(trade.entryTime),
          peakPnlPct: 0,
          currentPnlPct: 0,
          signalScore: trade.signalScore,
          tradeId: trade.id,
        });
      }
    }
    if (openTrades.length > 0) {
      logger.info(`Restored ${openTrades.length} open positions from trade log`);
    }
  }
}
