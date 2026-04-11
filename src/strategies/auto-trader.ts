import { NansenHyperliquidClient } from '../nansen/hyperliquid-client';
import { OnchainOsHyperliquidClient } from '../onchainos/hyperliquid-client';
import { PerpSentiment, PerpSide, SmartMoneyPerpTrade, PerpScreenerToken } from '../nansen/hyperliquid-types';
import { SignalScorer, ScoredOpportunity } from './signal-scorer';
import { RiskManager, RiskLevel, ActivePosition } from './risk-manager';
import { PortfolioTracker } from './portfolio-tracker';
import { AppConfig } from '../config';
import { logger } from '../utils/logger';
import { formatUsd, sleep } from '../utils/formatting';

/**
 * SmartMoneyAutoTrader — The main auto-trading loop.
 *
 * Cycle (every scanIntervalMinutes):
 * 1. Fetch account state + open positions
 * 2. Check existing positions for exit conditions (stop loss, take profit, trailing, sentiment flip)
 * 3. Scan Nansen for new opportunities across all HL perp tokens
 * 4. Score each opportunity (0-100)
 * 5. Enter top scoring opportunities that pass risk checks
 * 6. Log everything to portfolio tracker
 */

export interface AutoTraderConfig {
  scanIntervalMinutes: number;    // how often to run the cycle (default: 5)
  topTokensToScan: number;        // how many tokens to scan per cycle (default: 12)
  lookbackHours: number;          // nansen screener lookback (default: 4)
  riskLevel: RiskLevel;
  maxTradeSizeUsd: number;
}

export interface CycleResult {
  cycleNumber: number;
  timestamp: string;
  tokensScanned: number;
  opportunities: ScoredOpportunity[];
  tradesOpened: string[];         // token symbols
  tradesClosed: string[];         // token:reason
  positionsChecked: number;
  errors: string[];
}

type AutoTraderState = 'idle' | 'running' | 'paused' | 'stopped';

export class SmartMoneyAutoTrader {
  private nansenHL: NansenHyperliquidClient;
  private onchainHL: OnchainOsHyperliquidClient;
  private scorer: SignalScorer;
  private risk: RiskManager;
  private portfolio: PortfolioTracker;
  private config: AutoTraderConfig;
  private appConfig: AppConfig;

  private state: AutoTraderState = 'idle';
  private cycleCount = 0;
  private activePositions: ActivePosition[] = [];
  private onCycleComplete?: (result: CycleResult) => void;

  constructor(
    nansenHL: NansenHyperliquidClient,
    onchainHL: OnchainOsHyperliquidClient,
    appConfig: AppConfig,
    overrides?: Partial<AutoTraderConfig>,
  ) {
    this.nansenHL = nansenHL;
    this.onchainHL = onchainHL;
    this.appConfig = appConfig;

    this.config = {
      scanIntervalMinutes: overrides?.scanIntervalMinutes ?? 5,
      topTokensToScan: overrides?.topTokensToScan ?? 12,
      lookbackHours: overrides?.lookbackHours ?? 4,
      riskLevel: overrides?.riskLevel ?? (appConfig.agent.riskLevel as RiskLevel) ?? 'medium',
      maxTradeSizeUsd: overrides?.maxTradeSizeUsd ?? appConfig.agent.maxTradeSizeUsd ?? 500,
    };

    this.scorer = new SignalScorer();
    this.risk = new RiskManager(this.config.riskLevel, {
      maxPerTradeUsd: this.config.maxTradeSizeUsd,
    });
    this.portfolio = new PortfolioTracker();
  }

  /** Register callback for cycle completions (for CLI display) */
  onCycle(cb: (result: CycleResult) => void): void {
    this.onCycleComplete = cb;
  }

  /** Start the auto-trade loop */
  async start(): Promise<void> {
    if (this.state === 'running') {
      logger.warn('Auto-trader already running');
      return;
    }

    this.state = 'running';
    logger.signal('Auto-Trader STARTED');
    logger.info(`Config: scan every ${this.config.scanIntervalMinutes}m | risk: ${this.config.riskLevel} | max/trade: ${formatUsd(this.config.maxTradeSizeUsd)} | max leverage: ${this.risk.config.maxLeverage}x`);
    logger.info(`Min score to enter: ${this.risk.config.minScoreToEnter} | stop loss: ${this.risk.config.stopLossPct}% | take profit: ${this.risk.config.takeProfitPct}% | trailing: ${this.risk.config.trailingStopPct}%`);

    // Restore open positions from portfolio tracker
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

    logger.signal('Auto-Trader STOPPED');
  }

  /** Stop the loop */
  stop(): void {
    this.state = 'stopped';
  }

  /** Pause (no new trades, still monitors positions) */
  pause(): void {
    this.state = 'paused';
  }

  /** Resume from pause */
  resume(): void {
    if (this.state === 'paused') {
      this.state = 'running';
      logger.info('Auto-trader resumed');
    }
  }

  getState(): AutoTraderState { return this.state; }
  getPortfolio(): PortfolioTracker { return this.portfolio; }
  getRiskManager(): RiskManager { return this.risk; }
  getActivePositions(): ActivePosition[] { return [...this.activePositions]; }

  // ─── Core Cycle ─────────────────────────────────────────────────────────────

  async runCycle(): Promise<CycleResult> {
    this.cycleCount++;
    const result: CycleResult = {
      cycleNumber: this.cycleCount,
      timestamp: new Date().toISOString(),
      tokensScanned: 0,
      opportunities: [],
      tradesOpened: [],
      tradesClosed: [],
      positionsChecked: 0,
      errors: [],
    };

    logger.info(`── Cycle #${this.cycleCount} ──────────────────────────────────`);

    // ─── Phase 1: Check existing positions for exits ─────────────────────────
    await this.checkExistingPositions(result);

    // If paused, skip scanning for new entries
    if (this.state === 'paused') {
      logger.info('Paused — skipping scan for new entries');
      return result;
    }

    // ─── Phase 2: Scan for new opportunities ─────────────────────────────────
    const opportunities = await this.scanOpportunities(result);
    result.opportunities = opportunities;
    result.tokensScanned = opportunities.length;

    // ─── Phase 3: Enter top opportunities ────────────────────────────────────
    // Sort by score descending
    const sorted = opportunities
      .filter(o => o.score >= this.risk.config.minScoreToEnter)
      .sort((a, b) => b.score - a.score);

    if (sorted.length > 0) {
      logger.info(`Top opportunities: ${sorted.slice(0, 5).map(o =>
        `${o.token} ${o.side} (${o.score})`
      ).join(' | ')}`);
    }

    for (const opp of sorted) {
      const entered = await this.tryEnterPosition(opp, result);
      if (entered) result.tradesOpened.push(opp.token);
    }

    // ─── Phase 4: Summary ────────────────────────────────────────────────────
    const stats = this.portfolio.getStats();
    logger.info(`Cycle #${this.cycleCount} done — ${result.tradesOpened.length} opened, ${result.tradesClosed.length} closed | Open: ${this.activePositions.length} | Total PnL: ${formatUsd(stats.totalPnlUsd)} | WR: ${stats.winRate.toFixed(0)}%`);

    return result;
  }

  // ─── Phase 1: Position Monitoring ───────────────────────────────────────────

  private async checkExistingPositions(result: CycleResult): Promise<void> {
    if (this.activePositions.length === 0) return;

    logger.info(`Checking ${this.activePositions.length} open positions...`);
    result.positionsChecked = this.activePositions.length;

    const toClose: { pos: ActivePosition; reason: string }[] = [];

    for (const pos of this.activePositions) {
      try {
        // Get current sentiment for this token
        const sentiment = await this.nansenHL.getSmartMoneySentiment(pos.token);

        // Check if sentiment has flipped against us
        const sentimentFlipped = this.isSentimentFlipped(pos.side, sentiment);

        // Estimate current PnL from sentiment's mark price data
        // In production this would come from getAccountSummary()
        const markPrice = await this.getCurrentPrice(pos.token);
        const pnlPct = pos.side === 'Long'
          ? ((markPrice - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage
          : ((pos.entryPrice - markPrice) / pos.entryPrice) * 100 * pos.leverage;

        pos.currentPnlPct = pnlPct;

        const closeCheck = this.risk.shouldClosePosition(pos, pnlPct, sentimentFlipped);
        if (closeCheck.close) {
          toClose.push({ pos, reason: closeCheck.reason });
        }
      } catch (err) {
        result.errors.push(`Position check ${pos.token}: ${err}`);
      }
    }

    // Execute closes
    for (const { pos, reason } of toClose) {
      await this.closePosition(pos, reason, result);
    }
  }

  private isSentimentFlipped(ourSide: PerpSide, sentiment: PerpSentiment): boolean {
    if (ourSide === 'Long') {
      return sentiment.signal === 'strong_short' || sentiment.signal === 'lean_short';
    }
    return sentiment.signal === 'strong_long' || sentiment.signal === 'lean_long';
  }

  private async closePosition(pos: ActivePosition, reason: string, result: CycleResult): Promise<void> {
    try {
      logger.signal(`CLOSING ${pos.side} ${pos.token}: ${reason}`);

      await this.onchainHL.closePosition({
        token_symbol: pos.token,
        side: pos.side,
      });

      const markPrice = await this.getCurrentPrice(pos.token);
      this.portfolio.recordExit(pos.tradeId, markPrice, reason);
      this.risk.recordTrade(pos.token);

      // Remove from active
      this.activePositions = this.activePositions.filter(p => p.tradeId !== pos.tradeId);
      result.tradesClosed.push(`${pos.token}:${reason}`);
    } catch (err) {
      result.errors.push(`Close ${pos.token}: ${err}`);
      logger.error(`Failed to close ${pos.token}: ${err}`);
    }
  }

  // ─── Phase 2: Opportunity Scanning ──────────────────────────────────────────

  private async scanOpportunities(result: CycleResult): Promise<ScoredOpportunity[]> {
    const opportunities: ScoredOpportunity[] = [];

    try {
      // Get top active tokens from screener
      const screenerRes = await this.nansenHL.getTopSmartMoneyPerps(
        this.config.lookbackHours,
        this.config.topTokensToScan
      );

      // Get recent SM opens
      const recentTradesRes = await this.nansenHL.getSmartMoneyNewPositions(50);
      const recentTrades = recentTradesRes.data;

      // Score each token
      for (const token of screenerRes.data) {
        try {
          // Get sentiment
          const sentiment = await this.nansenHL.getSmartMoneySentiment(token.token_symbol);

          // Skip neutral — no edge
          if (sentiment.signal === 'neutral' && sentiment.confidence < 0.6) continue;

          // Try to get copy setup (non-blocking)
          let copySetup = null;
          try {
            copySetup = await this.nansenHL.getCopyTradeSetup(token.token_symbol);
          } catch { /* optional */ }

          const scored = this.scorer.score(sentiment, recentTrades, token, copySetup);
          opportunities.push(scored);
        } catch (err) {
          result.errors.push(`Score ${token.token_symbol}: ${err}`);
        }
      }
    } catch (err) {
      result.errors.push(`Scan: ${err}`);
      logger.error(`Scan failed: ${err}`);
    }

    return opportunities;
  }

  // ─── Phase 3: Position Entry ────────────────────────────────────────────────

  private async tryEnterPosition(opp: ScoredOpportunity, result: CycleResult): Promise<boolean> {
    const sizeUsd = this.risk.computePositionSize(opp.score, opp.confidence);
    const leverage = this.risk.computeLeverage(opp.score);

    // Get current account equity (use 0 in dry run)
    let equity = 0;
    try {
      const account = await this.onchainHL.getAccountSummary();
      equity = account.total_equity_usd;
    } catch { /* dry run returns 0 */ }

    const check = this.risk.canOpenPosition(
      opp.token,
      sizeUsd,
      opp.score,
      this.activePositions,
      equity,
    );

    if (!check.allowed) {
      logger.debug(`Skip ${opp.token} ${opp.side} (score ${opp.score}): ${check.reason}`);
      return false;
    }

    try {
      logger.signal(`ENTERING ${opp.side} ${opp.token} — score ${opp.score}, size ${formatUsd(sizeUsd)}, leverage ${leverage}x`);
      logger.info(`  Breakdown: sentiment=${opp.breakdown.sentimentScore} wallets=${opp.breakdown.walletCountScore} net=${opp.breakdown.netPositionScore} opens=${opp.breakdown.recentOpensScore} copy=${opp.breakdown.copyQualityScore}`);

      // Set leverage first
      await this.onchainHL.setLeverage({
        token_symbol: opp.token,
        leverage,
        leverage_type: 'Cross',
      });

      // Place order
      const orderResult = await this.onchainHL.placeOrder({
        token_symbol: opp.token,
        side: opp.side,
        order_type: 'Market',
        size_usd: sizeUsd,
        leverage,
        slippage_pct: 1,
      });

      // Track
      const tradeId = orderResult.order_id;
      const entryPrice = orderResult.avg_fill_price || opp.screenerData?.mark_price || 0;

      this.activePositions.push({
        token: opp.token,
        side: opp.side,
        entryPrice,
        sizeUsd,
        leverage,
        entryTime: new Date(),
        peakPnlPct: 0,
        currentPnlPct: 0,
        signalScore: opp.score,
        tradeId,
      });

      this.portfolio.recordEntry({
        id: tradeId,
        token: opp.token,
        side: opp.side,
        sizeUsd,
        leverage,
        entryPrice,
        entryTime: new Date().toISOString(),
        signalScore: opp.score,
        fees: orderResult.fee_usd,
      });

      this.risk.recordTrade(opp.token);
      return true;
    } catch (err) {
      result.errors.push(`Enter ${opp.token}: ${err}`);
      logger.error(`Failed to enter ${opp.token}: ${err}`);
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
      logger.info(`Restored ${openTrades.length} open positions from portfolio log`);
    }
  }
}
