import { PerpSide, PerpScreenerToken } from '../nansen/hyperliquid-types';
import { logger } from '../utils/logger';

/**
 * Entry Quality Estimator — Prevents entering trades where the edge
 * has already been captured by the source trader.
 *
 * THE FUNDAMENTAL PROBLEM OF COPY TRADING:
 * We always enter AFTER the source trader. By the time we detect their
 * trade, analyze the market, and execute, the price has moved.
 *
 * Example:
 *   SM trader opens Long BTC at $60,000
 *   We detect it → run 7 API calls → 2 minutes pass
 *   Current price: $60,150 (0.25% adverse)
 *   With 10x leverage: 2.5% of our SL budget already consumed
 *   If SL is 5%: we've burned 50% of our risk budget to slippage alone
 *
 * This module estimates how much edge remains after our delay.
 * If the answer is "not enough", we skip the trade.
 */

export interface EntryQuality {
  token: string;
  sourceEntryPrice: number;
  currentPrice: number;
  slippageBps: number;            // adverse price move in basis points
  slippagePctWithLeverage: number; // PnL impact at given leverage
  maxAcceptableBps: number;       // threshold for this token
  quality: 'excellent' | 'good' | 'acceptable' | 'poor' | 'skip';
  shouldEnter: boolean;
  reason: string;
}

/**
 * Token-specific slippage thresholds.
 *
 * Logic: Higher liquidity = tighter threshold (less slippage acceptable)
 *        Lower liquidity = wider threshold (more slippage is normal)
 *
 * These are ADVERSE entry thresholds — how much worse can our entry be
 * compared to the source trader before the trade loses expected value.
 */
const SLIPPAGE_THRESHOLDS_BPS: Record<string, number> = {
  // Tier 1: Deepest liquidity, minimal acceptable slippage
  BTC: 8,
  ETH: 10,

  // Tier 2: Major alts, moderate liquidity
  SOL: 20,
  AVAX: 25,
  LINK: 25,
  ARB: 25,
  OP: 25,
  DOGE: 20,

  // Tier 3: Mid caps, wider books
  SUI: 30,
  APT: 30,
  NEAR: 30,
  SEI: 35,
  AAVE: 30,
  UNI: 30,
  MKR: 35,

  // Tier 4: Small caps / memes, expect wider slippage
  WIF: 50,
  PENGU: 50,
  BONK: 50,
  PEPE: 50,
  HYPE: 40,
  PURR: 60,
};

const DEFAULT_THRESHOLD_BPS = 35;

export class EntryQualityEstimator {
  private recentSlippage = new Map<string, number[]>(); // token → last N slippage observations

  /**
   * Estimate entry quality for a copy trade.
   *
   * @param token Token symbol
   * @param side Trade direction
   * @param sourceEntryPrice Price the source trader entered at
   * @param currentPrice Current mark price
   * @param leverage Planned leverage
   * @param dynamicSLPct Dynamic stop loss % (from regime detector)
   */
  estimate(
    token: string,
    side: PerpSide,
    sourceEntryPrice: number,
    currentPrice: number,
    leverage: number,
    dynamicSLPct: number,
  ): EntryQuality {
    if (sourceEntryPrice <= 0 || currentPrice <= 0) {
      return {
        token, sourceEntryPrice, currentPrice,
        slippageBps: 0, slippagePctWithLeverage: 0,
        maxAcceptableBps: DEFAULT_THRESHOLD_BPS,
        quality: 'acceptable', shouldEnter: true,
        reason: 'No price data available — proceed with caution',
      };
    }

    // Compute adverse price movement
    // For LONG: current > source = we pay more (adverse)
    // For SHORT: current < source = we sell lower (adverse)
    let slippageBps: number;
    if (side === 'Long') {
      slippageBps = ((currentPrice - sourceEntryPrice) / sourceEntryPrice) * 10000;
    } else {
      slippageBps = ((sourceEntryPrice - currentPrice) / sourceEntryPrice) * 10000;
    }

    // If slippage is negative, price moved in our favor (rare but good)
    const adverseSlippage = Math.max(0, slippageBps);

    // PnL impact with leverage
    const slippagePctWithLeverage = (adverseSlippage / 10000) * 100 * leverage;

    // Get threshold for this token
    const maxAcceptableBps = SLIPPAGE_THRESHOLDS_BPS[token] ?? DEFAULT_THRESHOLD_BPS;

    // Quality classification
    let quality: EntryQuality['quality'];
    let shouldEnter: boolean;
    let reason: string;

    // Key insight: slippage relative to stop loss budget
    // If slippage consumes >30% of SL budget, entry is too poor
    const slippageAsPctOfSL = dynamicSLPct > 0
      ? (slippagePctWithLeverage / dynamicSLPct) * 100
      : 0;

    if (slippageBps <= 0) {
      quality = 'excellent';
      shouldEnter = true;
      reason = `Price moved in our favor: ${Math.abs(slippageBps).toFixed(1)}bps better entry than source`;
    } else if (adverseSlippage <= maxAcceptableBps * 0.3) {
      quality = 'good';
      shouldEnter = true;
      reason = `Minimal slippage: ${adverseSlippage.toFixed(1)}bps (${slippagePctWithLeverage.toFixed(2)}% PnL impact at ${leverage}x)`;
    } else if (adverseSlippage <= maxAcceptableBps && slippageAsPctOfSL < 30) {
      quality = 'acceptable';
      shouldEnter = true;
      reason = `Acceptable slippage: ${adverseSlippage.toFixed(1)}bps (${slippageAsPctOfSL.toFixed(0)}% of SL budget consumed)`;
    } else if (adverseSlippage <= maxAcceptableBps * 1.5 && slippageAsPctOfSL < 50) {
      quality = 'poor';
      shouldEnter = true; // Allow but reduce size
      reason = `High slippage: ${adverseSlippage.toFixed(1)}bps (${slippageAsPctOfSL.toFixed(0)}% of SL budget) — reduce position size`;
    } else {
      quality = 'skip';
      shouldEnter = false;
      reason = `Excessive slippage: ${adverseSlippage.toFixed(1)}bps > ${maxAcceptableBps}bps limit (${slippageAsPctOfSL.toFixed(0)}% of SL budget — edge already captured)`;
    }

    // Track for running average
    this.trackSlippage(token, adverseSlippage);

    return {
      token,
      sourceEntryPrice,
      currentPrice,
      slippageBps: adverseSlippage,
      slippagePctWithLeverage,
      maxAcceptableBps,
      quality,
      shouldEnter,
      reason,
    };
  }

  /**
   * Get size adjustment factor based on entry quality.
   * Poor quality → smaller position (less risk on worse entry).
   */
  getSizeMultiplier(quality: EntryQuality['quality']): number {
    switch (quality) {
      case 'excellent': return 1.0;
      case 'good': return 1.0;
      case 'acceptable': return 0.8;
      case 'poor': return 0.5;  // cut size in half for poor entries
      case 'skip': return 0;
    }
  }

  /**
   * Get average observed slippage for a token (from recent trades).
   * Useful for adjusting expectations over time.
   */
  getAvgSlippage(token: string): number {
    const observations = this.recentSlippage.get(token);
    if (!observations || observations.length === 0) return 0;
    return observations.reduce((a, b) => a + b, 0) / observations.length;
  }

  private trackSlippage(token: string, bps: number): void {
    const existing = this.recentSlippage.get(token) ?? [];
    existing.push(bps);
    // Keep last 20 observations
    if (existing.length > 20) existing.shift();
    this.recentSlippage.set(token, existing);
  }
}
