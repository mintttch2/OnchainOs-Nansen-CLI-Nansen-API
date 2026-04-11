import { PerpSide } from '../nansen/hyperliquid-types';
import { HLAccountSummary, HLPosition } from '../onchainos/hyperliquid-client';
import { logger } from '../utils/logger';

/**
 * Risk Manager — Guards the auto-trader against overexposure and catastrophic loss.
 *
 * Controls:
 * - Max simultaneous positions
 * - Max total exposure in USD
 * - Per-trade max loss (stop loss %)
 * - Per-trade take profit %
 * - Trailing stop from peak PnL
 * - Portfolio drawdown circuit breaker
 * - Position sizing by confidence
 */

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskConfig {
  maxPositions: number;
  maxExposureUsd: number;
  maxPerTradeUsd: number;
  stopLossPct: number;            // % loss to trigger stop (e.g. 5 = -5%)
  takeProfitPct: number;          // % gain to take profit
  trailingStopPct: number;        // trail from peak unrealized PnL
  maxDrawdownPct: number;         // halt trading if portfolio drops this much from peak
  minScoreToEnter: number;        // minimum signal score (0-100) to open a position
  maxLeverage: number;
  cooldownMinutes: number;        // min time between trades on same token
}

const RISK_PRESETS: Record<RiskLevel, RiskConfig> = {
  low: {
    maxPositions: 2,
    maxExposureUsd: 500,
    maxPerTradeUsd: 200,
    stopLossPct: 3,
    takeProfitPct: 8,
    trailingStopPct: 2,
    maxDrawdownPct: 10,
    minScoreToEnter: 75,
    maxLeverage: 5,
    cooldownMinutes: 60,
  },
  medium: {
    maxPositions: 4,
    maxExposureUsd: 2_000,
    maxPerTradeUsd: 500,
    stopLossPct: 5,
    takeProfitPct: 15,
    trailingStopPct: 3,
    maxDrawdownPct: 15,
    minScoreToEnter: 65,
    maxLeverage: 10,
    cooldownMinutes: 30,
  },
  high: {
    maxPositions: 6,
    maxExposureUsd: 5_000,
    maxPerTradeUsd: 1_000,
    stopLossPct: 8,
    takeProfitPct: 25,
    trailingStopPct: 5,
    maxDrawdownPct: 25,
    minScoreToEnter: 55,
    maxLeverage: 15,
    cooldownMinutes: 15,
  },
};

export interface ActivePosition {
  token: string;
  side: PerpSide;
  entryPrice: number;
  sizeUsd: number;
  leverage: number;
  entryTime: Date;
  peakPnlPct: number;            // highest seen PnL % (for trailing stop)
  currentPnlPct: number;
  signalScore: number;
  tradeId: string;
}

export class RiskManager {
  readonly config: RiskConfig;
  private peakEquityUsd = 0;
  private lastTradeTime = new Map<string, Date>();   // token → last trade time
  private circuitBroken = false;

  constructor(riskLevel: RiskLevel, overrides?: Partial<RiskConfig>) {
    this.config = { ...RISK_PRESETS[riskLevel], ...overrides };
  }

  /** Initialize peak equity from account summary */
  initEquity(equity: number): void {
    if (equity > this.peakEquityUsd) {
      this.peakEquityUsd = equity;
    }
  }

  /** Check if we can open a new position */
  canOpenPosition(
    token: string,
    sizeUsd: number,
    score: number,
    currentPositions: ActivePosition[],
    accountEquity: number,
  ): { allowed: boolean; reason: string } {
    // Circuit breaker
    if (this.circuitBroken) {
      return { allowed: false, reason: 'Circuit breaker active — portfolio drawdown exceeded limit' };
    }

    // Min score
    if (score < this.config.minScoreToEnter) {
      return { allowed: false, reason: `Score ${score} < minimum ${this.config.minScoreToEnter}` };
    }

    // Max positions
    if (currentPositions.length >= this.config.maxPositions) {
      return { allowed: false, reason: `At max positions (${this.config.maxPositions})` };
    }

    // Already in this token
    if (currentPositions.some(p => p.token === token)) {
      return { allowed: false, reason: `Already have position in ${token}` };
    }

    // Max per trade
    if (sizeUsd > this.config.maxPerTradeUsd) {
      return { allowed: false, reason: `Size $${sizeUsd} > max per trade $${this.config.maxPerTradeUsd}` };
    }

    // Max total exposure
    const currentExposure = currentPositions.reduce((sum, p) => sum + p.sizeUsd, 0);
    if (currentExposure + sizeUsd > this.config.maxExposureUsd) {
      return { allowed: false, reason: `Total exposure would exceed $${this.config.maxExposureUsd}` };
    }

    // Cooldown
    const lastTrade = this.lastTradeTime.get(token);
    if (lastTrade) {
      const minutesSince = (Date.now() - lastTrade.getTime()) / 60_000;
      if (minutesSince < this.config.cooldownMinutes) {
        return { allowed: false, reason: `Cooldown: ${Math.ceil(this.config.cooldownMinutes - minutesSince)}m left for ${token}` };
      }
    }

    // Drawdown check
    if (accountEquity > 0) {
      this.initEquity(accountEquity);
      const drawdownPct = ((this.peakEquityUsd - accountEquity) / this.peakEquityUsd) * 100;
      if (drawdownPct > this.config.maxDrawdownPct) {
        this.circuitBroken = true;
        logger.error(`CIRCUIT BREAKER: Drawdown ${drawdownPct.toFixed(1)}% exceeds ${this.config.maxDrawdownPct}%`);
        return { allowed: false, reason: `Portfolio drawdown ${drawdownPct.toFixed(1)}% > max ${this.config.maxDrawdownPct}%` };
      }
    }

    return { allowed: true, reason: 'OK' };
  }

  /** Determine position size based on confidence + risk config */
  computePositionSize(score: number, confidence: number): number {
    // Base: 30% of max per trade, scale up to 100% based on score
    const scoreScale = Math.max(0, (score - this.config.minScoreToEnter)) /
      (100 - this.config.minScoreToEnter);
    const base = this.config.maxPerTradeUsd * 0.3;
    const dynamic = this.config.maxPerTradeUsd * 0.7 * scoreScale * confidence;
    return Math.round(Math.min(base + dynamic, this.config.maxPerTradeUsd));
  }

  /** Determine leverage based on score + risk config */
  computeLeverage(score: number): number {
    // Low score = lower leverage, high score = up to max
    const scale = Math.max(0, (score - this.config.minScoreToEnter)) / (100 - this.config.minScoreToEnter);
    const lev = Math.max(2, Math.round(2 + (this.config.maxLeverage - 2) * scale));
    return Math.min(lev, this.config.maxLeverage);
  }

  /** Check if a position should be closed */
  shouldClosePosition(pos: ActivePosition, currentPnlPct: number, sentimentFlipped: boolean): {
    close: boolean;
    reason: string;
  } {
    // Update peak
    if (currentPnlPct > pos.peakPnlPct) {
      pos.peakPnlPct = currentPnlPct;
    }

    // Stop loss
    if (currentPnlPct <= -this.config.stopLossPct) {
      return { close: true, reason: `Stop loss: ${currentPnlPct.toFixed(2)}% <= -${this.config.stopLossPct}%` };
    }

    // Take profit
    if (currentPnlPct >= this.config.takeProfitPct) {
      return { close: true, reason: `Take profit: ${currentPnlPct.toFixed(2)}% >= ${this.config.takeProfitPct}%` };
    }

    // Trailing stop: if we've been in profit and now dropped
    if (pos.peakPnlPct > 2 && (pos.peakPnlPct - currentPnlPct) >= this.config.trailingStopPct) {
      return { close: true, reason: `Trailing stop: peak ${pos.peakPnlPct.toFixed(2)}%, now ${currentPnlPct.toFixed(2)}%` };
    }

    // Sentiment flip (SM turned against us)
    if (sentimentFlipped) {
      return { close: true, reason: `Sentiment flipped against position` };
    }

    // Max holding time: 24h
    const hoursHeld = (Date.now() - pos.entryTime.getTime()) / 3_600_000;
    if (hoursHeld > 24) {
      return { close: true, reason: `Max hold time (24h) exceeded` };
    }

    return { close: false, reason: 'Hold' };
  }

  /** Record that a trade was executed on a token (for cooldown tracking) */
  recordTrade(token: string): void {
    this.lastTradeTime.set(token, new Date());
  }

  /** Reset circuit breaker manually */
  resetCircuitBreaker(): void {
    this.circuitBroken = false;
    this.peakEquityUsd = 0;
    logger.warn('Circuit breaker reset');
  }

  get isCircuitBroken(): boolean {
    return this.circuitBroken;
  }
}
