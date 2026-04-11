import { NansenHyperliquidClient } from '../nansen/hyperliquid-client';
import { PerpScreenerToken } from '../nansen/hyperliquid-types';
import { logger } from '../utils/logger';

/**
 * Market Regime Detector — Determines the current market environment
 * so the copy engine can adapt its behavior.
 *
 * This is the most important piece: different strategies work in different regimes.
 * Copy trading works best in TRENDING markets. In choppy markets, we should
 * reduce activity. In squeeze-risk environments, we should either skip or fade.
 *
 * Why this matters for real PnL:
 * - Most copy trade losses come from entering during choppy/mean-revert markets
 *   where the SM trader's edge (trend following) doesn't apply
 * - A simple regime filter can cut losing trades by 30-50%
 *
 * Regimes:
 * - TRENDING: Clear directional move, SM consensus strong → best for copy
 * - CHOPPY: Split positioning, no clear direction → reduce size, widen stops
 * - SQUEEZE_RISK: Extreme crowding + liq clusters → skip or fade
 * - LOW_ACTIVITY: Not enough SM activity to have signal → skip
 */

export type MarketRegime = 'trending' | 'choppy' | 'squeeze_risk' | 'low_activity';

export interface RegimeAnalysis {
  regime: MarketRegime;
  confidence: number;           // 0-1 how confident in regime classification
  volatilityPct: number;        // estimated 24h price volatility as %
  volatilityTier: 'low' | 'medium' | 'high' | 'extreme';

  // Regime-specific recommendations
  sizeMultiplier: number;       // 0-1, multiply position size by this
  stopLossMultiplier: number;   // multiply base SL by this (>1 = wider stops)
  minScoreAdjustment: number;   // add this to min score threshold (+10 = pickier)
  shouldTrade: boolean;         // false = skip this cycle entirely

  reasoning: string;
}

export interface TokenVolatility {
  token: string;
  dailyRangePct: number;       // (high - low) / mid * 100 approximation
  fundingMagnitude: number;    // abs(funding rate) — proxy for crowding
  volumeToOiRatio: number;     // higher = more active
  priceChangePct: number;      // absolute 24h price change
}

/**
 * Asset correlation groups — tokens that move together.
 * Opening long BTC + long ETH is basically 2x the same bet.
 */
export const CORRELATION_GROUPS: Record<string, string[]> = {
  'majors':   ['BTC', 'ETH'],                              // ρ ≈ 0.85-0.95
  'l1_alts':  ['SOL', 'AVAX', 'SUI', 'APT', 'NEAR', 'SEI'],  // ρ ≈ 0.70-0.85
  'l2':       ['ARB', 'OP', 'STRK', 'MANTA'],             // ρ ≈ 0.75-0.90
  'defi':     ['UNI', 'AAVE', 'LINK', 'MKR', 'SNX'],      // ρ ≈ 0.60-0.80
  'meme':     ['DOGE', 'WIF', 'PENGU', 'BONK', 'PEPE'],   // ρ ≈ 0.50-0.75
  'hl_native':['HYPE', 'PURR'],                            // HL ecosystem
};

export class MarketRegimeDetector {
  private nansenHL: NansenHyperliquidClient;

  constructor(nansenHL: NansenHyperliquidClient) {
    this.nansenHL = nansenHL;
  }

  /**
   * Detect the current market regime for a specific token.
   * Uses on-chain data from Nansen as proxy for traditional indicators.
   */
  async detectRegime(token: string): Promise<RegimeAnalysis> {
    const vol = await this.estimateVolatility(token);
    return this.classifyRegime(vol);
  }

  /**
   * Detect the GLOBAL market regime (BTC + overall SM activity).
   * Used to decide whether to trade at all in this cycle.
   */
  async detectGlobalRegime(): Promise<RegimeAnalysis> {
    // Use BTC as global sentiment proxy
    const btcVol = await this.estimateVolatility('BTC');

    // Also check overall SM activity level
    try {
      const screener = await this.nansenHL.getTopSmartMoneyPerps(4, 30);
      const totalSmVolume = screener.data.reduce((s, t) =>
        s + (t.smart_money_volume ?? 0), 0
      );

      // If total SM volume is very low, it's a low activity regime
      if (totalSmVolume < 500_000) {
        return {
          regime: 'low_activity',
          confidence: 0.8,
          volatilityPct: btcVol.dailyRangePct,
          volatilityTier: this.classifyVolTier(btcVol.dailyRangePct),
          sizeMultiplier: 0.3,
          stopLossMultiplier: 1.5,
          minScoreAdjustment: 20,
          shouldTrade: false,
          reasoning: `Low SM activity: total volume ${(totalSmVolume/1000).toFixed(0)}K in last 4h — insufficient signal`,
        };
      }
    } catch { /* fall through to BTC-based regime */ }

    return this.classifyRegime(btcVol);
  }

  /**
   * Estimate token volatility from available Nansen data.
   *
   * Since we don't have OHLC/ATR, we use:
   * - Price change % as directional vol
   * - Funding rate magnitude as crowding proxy
   * - Volume/OI ratio as activity measure
   * - These combined give us a reasonable vol estimate
   */
  async estimateVolatility(token: string): Promise<TokenVolatility> {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    try {
      const res = await this.nansenHL.screenPerps({
        date: { from: yesterday.toISOString(), to: now.toISOString() },
        filters: { token_symbol: token },
        pagination: { page: 1, per_page: 1 },
      });

      const data = res.data[0];
      if (!data) {
        return { token, dailyRangePct: 3, fundingMagnitude: 0, volumeToOiRatio: 0, priceChangePct: 0 };
      }

      const markPrice = data.mark_price ?? 0;
      const prevPrice = data.previous_price_usd ?? markPrice;
      const priceChangePct = prevPrice > 0
        ? Math.abs((markPrice - prevPrice) / prevPrice) * 100
        : 0;

      // Estimate daily range as ~2x the absolute price change
      // (price change captures direction; range captures total movement)
      // This is a rough approximation — real ATR would be better
      const dailyRangePct = Math.max(priceChangePct * 2, 1);

      const funding = Math.abs(data.funding ?? 0);
      const volume = data.volume ?? 0;
      const oi = data.open_interest ?? 1;
      const volumeToOiRatio = oi > 0 ? volume / oi : 0;

      return {
        token,
        dailyRangePct,
        fundingMagnitude: funding * 10000, // in bps
        volumeToOiRatio,
        priceChangePct,
      };
    } catch {
      return { token, dailyRangePct: 3, fundingMagnitude: 0, volumeToOiRatio: 0, priceChangePct: 0 };
    }
  }

  /**
   * Classify regime from volatility data.
   *
   * The logic:
   * - SQUEEZE_RISK: Extreme funding (>10bps) → market is about to violently move
   *   against the crowded side. Either skip or trade small with wider stops.
   *
   * - TRENDING: Moderate-high vol + directional price move + reasonable funding
   *   This is where copy trading WORKS. SM are riding a trend.
   *
   * - CHOPPY: Moderate vol but no clear direction, or extreme vol with oscillation
   *   Copy trades will get stopped out. Reduce activity.
   *
   * - LOW_ACTIVITY: Very low vol, low volume → no signal to trade on.
   */
  private classifyRegime(vol: TokenVolatility): RegimeAnalysis {
    const volTier = this.classifyVolTier(vol.dailyRangePct);

    // ─── Squeeze Risk: Extreme crowding ─────────────────────────
    if (vol.fundingMagnitude > 10) {
      return {
        regime: 'squeeze_risk',
        confidence: Math.min(0.9, 0.5 + vol.fundingMagnitude / 30),
        volatilityPct: vol.dailyRangePct,
        volatilityTier: volTier,
        sizeMultiplier: 0.25,    // very small or skip
        stopLossMultiplier: 2.0, // wide stops if we do trade
        minScoreAdjustment: 25,  // need very strong signal
        shouldTrade: false,      // default: skip squeeze environments
        reasoning: `Squeeze risk: funding ${vol.fundingMagnitude.toFixed(1)}bps — extreme crowding, likely violent unwind`,
      };
    }

    // ─── Low Activity: No signal ────────────────────────────────
    if (vol.dailyRangePct < 1.5 && vol.volumeToOiRatio < 0.05) {
      return {
        regime: 'low_activity',
        confidence: 0.7,
        volatilityPct: vol.dailyRangePct,
        volatilityTier: 'low',
        sizeMultiplier: 0.5,
        stopLossMultiplier: 1.0,
        minScoreAdjustment: 15,
        shouldTrade: false,
        reasoning: `Low activity: vol ${vol.dailyRangePct.toFixed(1)}%, vol/OI ${vol.volumeToOiRatio.toFixed(3)} — dead market`,
      };
    }

    // ─── Trending: Directional with moderate vol ────────────────
    // Key: price actually moved AND vol isn't extreme
    if (vol.priceChangePct > 2 && vol.dailyRangePct < 15 && vol.fundingMagnitude < 8) {
      return {
        regime: 'trending',
        confidence: Math.min(0.9, 0.4 + vol.priceChangePct / 10),
        volatilityPct: vol.dailyRangePct,
        volatilityTier: volTier,
        sizeMultiplier: 1.0,     // full size
        stopLossMultiplier: 1.0, // normal stops
        minScoreAdjustment: 0,   // normal threshold
        shouldTrade: true,
        reasoning: `Trending: price moved ${vol.priceChangePct.toFixed(1)}%, vol ${vol.dailyRangePct.toFixed(1)}% — favorable for copy trades`,
      };
    }

    // ─── Choppy: Everything else ────────────────────────────────
    // Either: low directional move + moderate vol, or high vol without direction
    const isHighVol = vol.dailyRangePct > 8;
    return {
      regime: 'choppy',
      confidence: 0.6,
      volatilityPct: vol.dailyRangePct,
      volatilityTier: volTier,
      sizeMultiplier: isHighVol ? 0.4 : 0.6,     // reduce size
      stopLossMultiplier: isHighVol ? 1.8 : 1.3,  // wider stops
      minScoreAdjustment: isHighVol ? 15 : 8,     // pickier entry
      shouldTrade: true,                           // can trade, but carefully
      reasoning: `Choppy: vol ${vol.dailyRangePct.toFixed(1)}% but price only ${vol.priceChangePct.toFixed(1)}% directional — reduce activity`,
    };
  }

  private classifyVolTier(pct: number): TokenVolatility['dailyRangePct'] extends number ? RegimeAnalysis['volatilityTier'] : never {
    if (pct < 2) return 'low' as any;
    if (pct < 6) return 'medium' as any;
    if (pct < 12) return 'high' as any;
    return 'extreme' as any;
  }

  /**
   * Get the correlation group for a token.
   * Returns null if token isn't in any known group.
   */
  static getCorrelationGroup(token: string): string | null {
    for (const [group, tokens] of Object.entries(CORRELATION_GROUPS)) {
      if (tokens.includes(token)) return group;
    }
    return null;
  }

  /**
   * Check if a new trade would create excessive correlated exposure.
   *
   * Logic: If we already have a position in the same correlation group
   * with the same direction, that's 2x the same bet.
   * We limit to 1 position per correlation group per direction.
   */
  static checkCorrelationRisk(
    newToken: string,
    newSide: string,
    existingPositions: Array<{ token: string; side: string; sizeUsd: number }>,
  ): { excessive: boolean; existingCorrelated: string[]; group: string | null } {
    const newGroup = this.getCorrelationGroup(newToken);
    if (!newGroup) {
      return { excessive: false, existingCorrelated: [], group: null };
    }

    const correlatedPositions = existingPositions.filter(p => {
      const pGroup = this.getCorrelationGroup(p.token);
      return pGroup === newGroup && p.side === newSide;
    });

    return {
      excessive: correlatedPositions.length >= 1, // max 1 per group per direction
      existingCorrelated: correlatedPositions.map(p => p.token),
      group: newGroup,
    };
  }

  /**
   * Compute dynamic stop loss based on volatility.
   *
   * Why this matters:
   * A fixed 5% SL on a token with 12% daily range = guaranteed stop hunt.
   * A fixed 5% SL on a token with 2% daily range = too wide, takes unnecessary loss.
   *
   * Formula: SL = clamp(baseStopLoss, 1.5 * dailyVol, 3 * dailyVol)
   * This gives the trade room to breathe without excessive risk.
   *
   * For 10x leverage on a 5% daily range token:
   * - Fixed 5% SL = gets hit on normal intraday swing
   * - Dynamic SL = max(5, 1.5*5) = 7.5% → survives normal movement
   */
  static computeDynamicStopLoss(
    baseSLPct: number,
    volatilityPct: number,
    leverage: number,
  ): number {
    // Wider stop for higher vol, narrower for low vol
    // But never tighter than 60% of base or wider than 3x base
    const volAdjusted = volatilityPct * 1.5;
    const adjustedSL = Math.max(baseSLPct * 0.6, Math.min(volAdjusted, baseSLPct * 3));

    // Leverage adjustment: higher leverage = need tighter stops
    // because the same % price move = bigger PnL impact
    // But we've already factored leverage into PnL calculation,
    // so the SL is in terms of position PnL %, not price %
    return Math.round(adjustedSL * 10) / 10;
  }

  /**
   * Compute dynamic take profit based on volatility.
   *
   * In trending markets with high vol, we want wider TP to capture the full move.
   * In low vol, tighter TP because the move is smaller.
   *
   * Also: use 2:1 or 3:1 risk-reward ratio minimum.
   * If SL is 7%, TP should be at least 14% (2R).
   */
  static computeDynamicTakeProfit(
    baseTPPct: number,
    dynamicSLPct: number,
    volatilityPct: number,
    regime: MarketRegime,
  ): number {
    // Minimum 2R in trending, 1.5R in choppy
    const minRR = regime === 'trending' ? 2.0 : 1.5;
    const rrBased = dynamicSLPct * minRR;

    // Vol-adjusted TP
    const volAdjusted = volatilityPct * 2.5;

    // Take the higher of: base, RR-based, or vol-adjusted
    const tp = Math.max(baseTPPct, rrBased, volAdjusted);

    // Cap at reasonable level
    return Math.round(Math.min(tp, baseTPPct * 3) * 10) / 10;
  }

  /**
   * Compute position size based on risk-per-trade, not fixed USD.
   *
   * This is the most important sizing concept:
   * Instead of "always trade $500", we say "always risk $25" (5% of $500).
   * Then: size = riskAmount / (stopLossPct / leverage)
   *
   * This means:
   * - Wider SL (high vol token) → smaller position → same dollar risk
   * - Tighter SL (low vol token) → larger position → same dollar risk
   *
   * Result: consistent risk per trade regardless of volatility.
   */
  static computeRiskBasedSize(
    maxPerTradeUsd: number,
    riskPct: number,            // % of max we're willing to lose (e.g. 5 = 5%)
    dynamicSLPct: number,
    leverage: number,
  ): number {
    // How much $ we risk per trade
    const riskAmount = maxPerTradeUsd * (riskPct / 100);

    // What size position gives us exactly riskAmount loss at stop loss
    // PnL at SL = size * (SL% / 100) → we want this = riskAmount
    // size = riskAmount / (SL% / 100)
    const size = riskAmount / (dynamicSLPct / 100);

    // Cap at maxPerTradeUsd
    return Math.round(Math.min(size, maxPerTradeUsd));
  }
}
