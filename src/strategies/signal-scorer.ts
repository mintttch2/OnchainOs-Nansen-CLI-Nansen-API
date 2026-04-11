import { PerpSentiment, CopyTradeSetup, SmartMoneyPerpTrade, PerpScreenerToken, PerpSide } from '../nansen/hyperliquid-types';

/**
 * Signal Scorer — Converts multiple Nansen data signals into a single 0-100
 * tradability score for each token + direction.
 *
 * Score breakdown (max 100):
 *   Sentiment signal:      0-35 points
 *   SM wallet count:       0-15 points
 *   Net position magnitude: 0-15 points
 *   Recent SM opens:       0-20 points
 *   Copy trade quality:    0-15 points
 */

export interface ScoredOpportunity {
  token: string;
  side: PerpSide;
  score: number;                  // 0-100 composite
  confidence: number;             // 0-1 from sentiment
  sentiment: PerpSentiment;
  copySetup: CopyTradeSetup | null;
  recentOpens: number;            // count of SM opens in last 4h
  recentOpensUsd: number;         // total USD of those opens
  screenerData: PerpScreenerToken | null;
  breakdown: ScoreBreakdown;
}

export interface ScoreBreakdown {
  sentimentScore: number;         // 0-35
  walletCountScore: number;       // 0-15
  netPositionScore: number;       // 0-15
  recentOpensScore: number;       // 0-20
  copyQualityScore: number;       // 0-15
}

export class SignalScorer {

  /**
   * Score a single token opportunity for a given direction.
   */
  score(
    sentiment: PerpSentiment,
    recentTrades: SmartMoneyPerpTrade[],
    screener: PerpScreenerToken | null,
    copySetup: CopyTradeSetup | null,
  ): ScoredOpportunity {
    // Determine direction from sentiment
    const side = this.deriveSide(sentiment);

    // Filter recent trades matching this token + aligned direction
    const alignedTrades = recentTrades.filter(t =>
      t.token_symbol === sentiment.token_symbol &&
      this.tradeAligns(t, side)
    );

    const recentOpensUsd = alignedTrades.reduce((sum, t) => sum + t.value_usd, 0);

    const breakdown = this.computeBreakdown(sentiment, alignedTrades.length, recentOpensUsd, screener, copySetup, side);
    const score = breakdown.sentimentScore + breakdown.walletCountScore +
      breakdown.netPositionScore + breakdown.recentOpensScore + breakdown.copyQualityScore;

    return {
      token: sentiment.token_symbol,
      side,
      score: Math.min(100, Math.round(score)),
      confidence: sentiment.confidence,
      sentiment,
      copySetup,
      recentOpens: alignedTrades.length,
      recentOpensUsd,
      screenerData: screener,
      breakdown,
    };
  }

  private deriveSide(s: PerpSentiment): PerpSide {
    if (s.signal === 'strong_long' || s.signal === 'lean_long') return 'Long';
    if (s.signal === 'strong_short' || s.signal === 'lean_short') return 'Short';
    // Neutral — use net position direction
    return s.net_position_usd >= 0 ? 'Long' : 'Short';
  }

  private tradeAligns(trade: SmartMoneyPerpTrade, side: PerpSide): boolean {
    if (side === 'Long') {
      return trade.action.includes('Open Long') || trade.action.includes('Add Long');
    }
    return trade.action.includes('Open Short') || trade.action.includes('Add Short');
  }

  private computeBreakdown(
    sentiment: PerpSentiment,
    alignedTradesCount: number,
    alignedTradesUsd: number,
    screener: PerpScreenerToken | null,
    copySetup: CopyTradeSetup | null,
    side: PerpSide,
  ): ScoreBreakdown {

    // ── 1. Sentiment Score (0-35) ──
    const signalStrengths: Record<string, number> = {
      strong_long: 35, lean_long: 22, neutral: 0, lean_short: 22, strong_short: 35,
    };
    let sentimentScore = signalStrengths[sentiment.signal] ?? 0;
    // Penalize if sentiment direction doesn't match our side
    const sentimentSide = this.deriveSide(sentiment);
    if (sentimentSide !== side && sentiment.signal !== 'neutral') {
      sentimentScore = 0;
    }

    // ── 2. Wallet Count Score (0-15) ──
    const walletCount = side === 'Long' ? sentiment.smart_money_longs_count : sentiment.smart_money_shorts_count;
    // Scale: 1 wallet = 2pts, 5+ = 10pts, 10+ = 15pts
    const walletCountScore = Math.min(15, walletCount * 1.5);

    // ── 3. Net Position Magnitude (0-15) ──
    const absNet = Math.abs(sentiment.net_position_usd);
    // Scale: $100K = 5pts, $500K = 10pts, $1M+ = 15pts
    let netPositionScore = 0;
    if (absNet >= 1_000_000) netPositionScore = 15;
    else if (absNet >= 500_000) netPositionScore = 10;
    else if (absNet >= 100_000) netPositionScore = 5 + (absNet - 100_000) / 80_000;
    else netPositionScore = absNet / 20_000;
    // Only counts if net direction aligns with our side
    const netLong = sentiment.net_position_usd >= 0;
    if ((side === 'Long' && !netLong) || (side === 'Short' && netLong)) {
      netPositionScore = 0;
    }

    // ── 4. Recent SM Opens (0-20) ──
    // Scale: 1 open = 5pts, 3+ = 12pts, 5+ = 17pts, 8+ = 20pts
    let recentOpensScore = Math.min(20, alignedTradesCount * 3);
    // Bonus for large USD volumes
    if (alignedTradesUsd > 500_000) recentOpensScore = Math.min(20, recentOpensScore + 3);
    if (alignedTradesUsd > 1_000_000) recentOpensScore = Math.min(20, recentOpensScore + 2);

    // ── 5. Copy Trade Quality (0-15) ──
    let copyQualityScore = 0;
    if (copySetup && copySetup.side === side) {
      // PnL component (0-8): profitable trader is better
      if (copySetup.trader_unrealized_pnl_usd > 100_000) copyQualityScore += 8;
      else if (copySetup.trader_unrealized_pnl_usd > 10_000) copyQualityScore += 5;
      else if (copySetup.trader_unrealized_pnl_usd > 1_000) copyQualityScore += 3;

      // Safety component (0-7): dist to liq
      const distToLiq = Math.abs(screener?.mark_price ?? 0 - copySetup.liquidation_price);
      const distPct = screener?.mark_price ? (distToLiq / screener.mark_price * 100) : 20;
      if (distPct > 30) copyQualityScore += 7;
      else if (distPct > 15) copyQualityScore += 5;
      else if (distPct > 5) copyQualityScore += 2;
    }

    return {
      sentimentScore: Math.round(sentimentScore * 10) / 10,
      walletCountScore: Math.round(walletCountScore * 10) / 10,
      netPositionScore: Math.round(netPositionScore * 10) / 10,
      recentOpensScore: Math.round(recentOpensScore * 10) / 10,
      copyQualityScore: Math.round(copyQualityScore * 10) / 10,
    };
  }
}
