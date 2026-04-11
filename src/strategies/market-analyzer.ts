import { NansenHyperliquidClient } from '../nansen/hyperliquid-client';
import { PerpSide, PerpSentiment, PerpScreenerToken, TokenPerpPosition } from '../nansen/hyperliquid-types';
import { logger } from '../utils/logger';

/**
 * Market Analyzer — Evaluates market conditions for a token using
 * multiple on-chain indicators BEFORE allowing a copy trade.
 *
 * This is what makes the bot smart: it doesn't blindly copy.
 * It validates that market structure confirms the trade direction.
 *
 * Indicators analyzed:
 * 1. Funding Rate — Crowded positioning signal
 * 2. Open Interest trend — New money entering or exiting
 * 3. Smart Money Consensus — Are most SM wallets aligned?
 * 4. Price Momentum — Token trending in the right direction?
 * 5. Liquidation Risk Map — Are there liquidation clusters nearby?
 * 6. Buy/Sell Pressure — Recent 24h flow direction
 * 7. SM Position Concentration — Is conviction concentrated or spread?
 */

export interface MarketCondition {
  token: string;
  side: PerpSide;
  timestamp: Date;

  // Individual indicator scores (each -1 to +1)
  // Positive = confirms the trade direction, negative = contradicts
  indicators: {
    fundingRate: IndicatorResult;
    openInterest: IndicatorResult;
    smConsensus: IndicatorResult;
    priceMomentum: IndicatorResult;
    liquidationRisk: IndicatorResult;
    buySellPressure: IndicatorResult;
    positionConcentration: IndicatorResult;
  };

  // Composite
  compositeScore: number;          // -1 to +1 (positive = market confirms direction)
  confirmsPct: number;            // 0-100% of indicators confirming
  verdict: 'strong_confirm' | 'confirm' | 'neutral' | 'reject' | 'strong_reject';
  reasoning: string[];
}

export interface IndicatorResult {
  name: string;
  value: number;                   // raw value
  score: number;                   // -1 to +1 (positive = confirms trade direction)
  label: string;                   // human readable
  weight: number;                  // importance weight
}

export class MarketAnalyzer {
  private nansenHL: NansenHyperliquidClient;

  constructor(nansenHL: NansenHyperliquidClient) {
    this.nansenHL = nansenHL;
  }

  /**
   * Analyze market conditions for a token before copying a trade.
   * Returns a verdict on whether market structure supports the trade.
   */
  async analyze(token: string, side: PerpSide): Promise<MarketCondition> {
    logger.info(`Analyzing market conditions for ${side} ${token}...`);

    // Fetch all needed data in parallel
    const [sentiment, screenerData, positions] = await Promise.all([
      this.nansenHL.getSmartMoneySentiment(token),
      this.getScreenerData(token),
      this.getPositionData(token),
    ]);

    const indicators = {
      fundingRate: this.analyzeFundingRate(screenerData, side),
      openInterest: this.analyzeOpenInterest(screenerData, side),
      smConsensus: this.analyzeSmConsensus(sentiment, side),
      priceMomentum: this.analyzePriceMomentum(screenerData, side),
      liquidationRisk: this.analyzeLiquidationRisk(positions, side),
      buySellPressure: this.analyzeBuySellPressure(sentiment, screenerData, side),
      positionConcentration: this.analyzeConcentration(positions, sentiment, side),
    };

    // Weighted composite score
    const allIndicators = Object.values(indicators);
    const totalWeight = allIndicators.reduce((s, i) => s + i.weight, 0);
    const compositeScore = allIndicators.reduce((s, i) => s + i.score * i.weight, 0) / totalWeight;

    // How many indicators confirm?
    const confirming = allIndicators.filter(i => i.score > 0).length;
    const confirmsPct = (confirming / allIndicators.length) * 100;

    // Verdict
    let verdict: MarketCondition['verdict'];
    if (compositeScore >= 0.4) verdict = 'strong_confirm';
    else if (compositeScore >= 0.15) verdict = 'confirm';
    else if (compositeScore >= -0.15) verdict = 'neutral';
    else if (compositeScore >= -0.4) verdict = 'reject';
    else verdict = 'strong_reject';

    // Build reasoning
    const reasoning: string[] = [];
    for (const ind of allIndicators) {
      const emoji = ind.score > 0.1 ? '+' : ind.score < -0.1 ? '-' : '~';
      reasoning.push(`[${emoji}] ${ind.name}: ${ind.label}`);
    }

    return {
      token,
      side,
      timestamp: new Date(),
      indicators,
      compositeScore: Math.round(compositeScore * 100) / 100,
      confirmsPct: Math.round(confirmsPct),
      verdict,
      reasoning,
    };
  }

  // ─── Individual Indicators ──────────────────────────────────────────────────

  /**
   * Funding Rate Analysis
   * - Positive funding = longs pay shorts → longs are crowded
   * - For a LONG: negative funding is good (shorts are paying, not crowded)
   * - For a SHORT: positive funding is good (longs are overpaying)
   */
  private analyzeFundingRate(screener: PerpScreenerToken | null, side: PerpSide): IndicatorResult {
    const funding = screener?.funding ?? 0;
    const fundingBps = funding * 10000; // convert to basis points

    let score: number;
    let label: string;

    if (side === 'Long') {
      // Negative funding = good for longs (shorts pay)
      if (fundingBps <= -5) { score = 0.8; label = `Funding strongly negative (${fundingBps.toFixed(1)}bps) — shorts paying, longs not crowded`; }
      else if (fundingBps <= -1) { score = 0.4; label = `Funding negative (${fundingBps.toFixed(1)}bps) — favorable for longs`; }
      else if (fundingBps <= 3) { score = 0; label = `Funding neutral (${fundingBps.toFixed(1)}bps)`; }
      else if (fundingBps <= 10) { score = -0.3; label = `Funding positive (${fundingBps.toFixed(1)}bps) — longs somewhat crowded`; }
      else { score = -0.7; label = `Funding very high (${fundingBps.toFixed(1)}bps) — longs overcrowded, risky to enter`; }
    } else {
      // Positive funding = good for shorts (longs pay)
      if (fundingBps >= 5) { score = 0.8; label = `Funding strongly positive (${fundingBps.toFixed(1)}bps) — longs paying, good for shorts`; }
      else if (fundingBps >= 1) { score = 0.4; label = `Funding positive (${fundingBps.toFixed(1)}bps) — favorable for shorts`; }
      else if (fundingBps >= -3) { score = 0; label = `Funding neutral (${fundingBps.toFixed(1)}bps)`; }
      else if (fundingBps >= -10) { score = -0.3; label = `Funding negative (${fundingBps.toFixed(1)}bps) — shorts somewhat crowded`; }
      else { score = -0.7; label = `Funding very negative (${fundingBps.toFixed(1)}bps) — shorts overcrowded`; }
    }

    return { name: 'Funding Rate', value: funding, score, label, weight: 1.5 };
  }

  /**
   * Open Interest Analysis
   * - Rising OI + price direction aligned = strong trend
   * - Falling OI = positions closing, trend may be exhausting
   */
  private analyzeOpenInterest(screener: PerpScreenerToken | null, side: PerpSide): IndicatorResult {
    const oi = screener?.open_interest ?? 0;
    const volume = screener?.volume ?? 0;

    // Use volume/OI ratio as a proxy for OI trend
    // High volume relative to OI = new positions being opened
    const volOiRatio = oi > 0 ? volume / oi : 0;

    let score: number;
    let label: string;

    if (volOiRatio > 0.5) { score = 0.5; label = `High volume/OI ratio (${volOiRatio.toFixed(2)}) — strong activity, new positions entering`; }
    else if (volOiRatio > 0.2) { score = 0.2; label = `Moderate activity (vol/OI: ${volOiRatio.toFixed(2)})`; }
    else if (volOiRatio > 0.05) { score = 0; label = `Normal activity (vol/OI: ${volOiRatio.toFixed(2)})`; }
    else { score = -0.3; label = `Low activity (vol/OI: ${volOiRatio.toFixed(2)}) — thin market, wider spreads`; }

    return { name: 'Open Interest', value: oi, score, label, weight: 1.0 };
  }

  /**
   * Smart Money Consensus
   * - How many SM wallets agree on the direction?
   * - Strong consensus = higher conviction signal
   */
  private analyzeSmConsensus(sentiment: PerpSentiment, side: PerpSide): IndicatorResult {
    const totalWallets = sentiment.smart_money_longs_count + sentiment.smart_money_shorts_count;
    const alignedWallets = side === 'Long' ? sentiment.smart_money_longs_count : sentiment.smart_money_shorts_count;
    const alignedPct = totalWallets > 0 ? (alignedWallets / totalWallets) * 100 : 50;
    const alignedUsd = side === 'Long' ? sentiment.smart_money_long_usd : sentiment.smart_money_short_usd;

    let score: number;
    let label: string;

    if (alignedPct >= 75) {
      score = 0.9;
      label = `Strong consensus: ${alignedPct.toFixed(0)}% of SM wallets are ${side} (${alignedWallets}/${totalWallets})`;
    } else if (alignedPct >= 60) {
      score = 0.5;
      label = `Moderate consensus: ${alignedPct.toFixed(0)}% of SM wallets are ${side}`;
    } else if (alignedPct >= 45) {
      score = 0;
      label = `Split market: ${alignedPct.toFixed(0)}% aligned, no clear consensus`;
    } else if (alignedPct >= 30) {
      score = -0.5;
      label = `Majority SM disagrees: only ${alignedPct.toFixed(0)}% on our side`;
    } else {
      score = -0.9;
      label = `SM strongly opposed: ${alignedPct.toFixed(0)}% aligned — ${side} is contrarian`;
    }

    return { name: 'SM Consensus', value: alignedPct, score, label, weight: 2.0 };
  }

  /**
   * Price Momentum
   * - Is price moving in the direction of the trade?
   * - Uses mark_price vs previous_price from screener
   */
  private analyzePriceMomentum(screener: PerpScreenerToken | null, side: PerpSide): IndicatorResult {
    const markPrice = screener?.mark_price ?? 0;
    const prevPrice = screener?.previous_price_usd ?? markPrice;

    if (markPrice === 0 || prevPrice === 0) {
      return { name: 'Price Momentum', value: 0, score: 0, label: 'No price data available', weight: 1.0 };
    }

    const changePct = ((markPrice - prevPrice) / prevPrice) * 100;

    let score: number;
    let label: string;

    if (side === 'Long') {
      if (changePct > 5) { score = 0.6; label = `Strong uptrend (+${changePct.toFixed(2)}%) — momentum aligned`; }
      else if (changePct > 1) { score = 0.3; label = `Moderate uptrend (+${changePct.toFixed(2)}%)`; }
      else if (changePct > -1) { score = 0; label = `Sideways (${changePct.toFixed(2)}%)`; }
      else if (changePct > -5) { score = -0.2; label = `Slight dip (${changePct.toFixed(2)}%) — could be buying opportunity or falling knife`; }
      else { score = -0.6; label = `Strong downtrend (${changePct.toFixed(2)}%) — risky to go long`; }
    } else {
      if (changePct < -5) { score = 0.6; label = `Strong downtrend (${changePct.toFixed(2)}%) — momentum aligned for short`; }
      else if (changePct < -1) { score = 0.3; label = `Moderate downtrend (${changePct.toFixed(2)}%)`; }
      else if (changePct < 1) { score = 0; label = `Sideways (${changePct.toFixed(2)}%)`; }
      else if (changePct < 5) { score = -0.2; label = `Slight rally (+${changePct.toFixed(2)}%) — counter to short`; }
      else { score = -0.6; label = `Strong uptrend (+${changePct.toFixed(2)}%) — risky to short`; }
    }

    return { name: 'Price Momentum', value: changePct, score, label, weight: 1.2 };
  }

  /**
   * Liquidation Risk Map
   * - Are there liquidation clusters near the current price?
   * - Liq clusters on the opposing side can act as fuel (squeeze targets)
   * - Liq clusters on our side = risk of cascade
   */
  private analyzeLiquidationRisk(
    positions: TokenPerpPosition[],
    side: PerpSide,
  ): IndicatorResult {
    if (positions.length === 0) {
      return { name: 'Liquidation Risk', value: 0, score: 0, label: 'No position data', weight: 1.0 };
    }

    const markPrice = positions[0]?.mark_price ?? 0;
    if (markPrice === 0) {
      return { name: 'Liquidation Risk', value: 0, score: 0, label: 'No mark price', weight: 1.0 };
    }

    // Find liquidation clusters near current price (within 10%)
    const nearbyThreshold = 0.10;
    const opposingSide = side === 'Long' ? 'Short' : 'Long';

    const nearbyOppositeLiqs = positions.filter(p => {
      if (p.side !== opposingSide) return false;
      const dist = Math.abs(p.liquidation_price - markPrice) / markPrice;
      return dist < nearbyThreshold;
    });

    const nearbyOurSideLiqs = positions.filter(p => {
      if (p.side !== side) return false;
      const dist = Math.abs(p.liquidation_price - markPrice) / markPrice;
      return dist < nearbyThreshold;
    });

    const oppositeLiqValue = nearbyOppositeLiqs.reduce((s, p) => s + Math.abs(p.position_value_usd), 0);
    const ourSideLiqValue = nearbyOurSideLiqs.reduce((s, p) => s + Math.abs(p.position_value_usd), 0);

    let score: number;
    let label: string;

    if (oppositeLiqValue > ourSideLiqValue * 2 && oppositeLiqValue > 100_000) {
      score = 0.7;
      label = `Squeeze potential: ${nearbyOppositeLiqs.length} opposing positions near liquidation ($${(oppositeLiqValue/1000).toFixed(0)}K)`;
    } else if (ourSideLiqValue > oppositeLiqValue * 2 && ourSideLiqValue > 100_000) {
      score = -0.5;
      label = `Cascade risk: ${nearbyOurSideLiqs.length} same-side positions near liquidation ($${(ourSideLiqValue/1000).toFixed(0)}K)`;
    } else if (oppositeLiqValue > ourSideLiqValue) {
      score = 0.2;
      label = `Slightly favorable liq map`;
    } else {
      score = -0.1;
      label = `Slightly unfavorable liq map`;
    }

    return { name: 'Liquidation Risk', value: oppositeLiqValue - ourSideLiqValue, score, label, weight: 1.3 };
  }

  /**
   * Buy/Sell Pressure
   * - Direction of 24h SM flow
   * - Strong buy pressure for a long = good
   */
  private analyzeBuySellPressure(
    sentiment: PerpSentiment,
    screener: PerpScreenerToken | null,
    side: PerpSide,
  ): IndicatorResult {
    const buyPct = sentiment.buy_pressure_pct;
    const sellPct = 100 - buyPct;
    const netFlow = sentiment.net_flow_24h_usd;

    let score: number;
    let label: string;

    if (side === 'Long') {
      if (buyPct >= 70) { score = 0.8; label = `Strong buying pressure: ${buyPct.toFixed(0)}% buys, net flow +$${(netFlow/1000).toFixed(0)}K`; }
      else if (buyPct >= 55) { score = 0.3; label = `Moderate buying: ${buyPct.toFixed(0)}% buys`; }
      else if (buyPct >= 45) { score = 0; label = `Balanced flow: ${buyPct.toFixed(0)}% buy / ${sellPct.toFixed(0)}% sell`; }
      else if (buyPct >= 30) { score = -0.4; label = `Selling pressure: ${sellPct.toFixed(0)}% sells — SM exiting longs`; }
      else { score = -0.8; label = `Heavy selling: ${sellPct.toFixed(0)}% sells — strong headwind for longs`; }
    } else {
      if (sellPct >= 70) { score = 0.8; label = `Strong selling pressure: ${sellPct.toFixed(0)}% sells — confirms short`; }
      else if (sellPct >= 55) { score = 0.3; label = `Moderate selling: ${sellPct.toFixed(0)}% sells`; }
      else if (sellPct >= 45) { score = 0; label = `Balanced flow`; }
      else if (sellPct >= 30) { score = -0.4; label = `Buying pressure: ${buyPct.toFixed(0)}% buys — headwind for shorts`; }
      else { score = -0.8; label = `Heavy buying: ${buyPct.toFixed(0)}% buys — strong headwind for shorts`; }
    }

    return { name: 'Buy/Sell Pressure', value: buyPct, score, label, weight: 1.5 };
  }

  /**
   * Position Concentration
   * - Is the SM conviction spread across many wallets or concentrated in 1-2?
   * - Broad conviction = more reliable signal
   * - One whale = higher risk of sudden exit
   */
  private analyzeConcentration(
    positions: TokenPerpPosition[],
    sentiment: PerpSentiment,
    side: PerpSide,
  ): IndicatorResult {
    const alignedPositions = positions.filter(p => p.side === side);

    if (alignedPositions.length === 0) {
      return { name: 'Position Concentration', value: 0, score: -0.3, label: 'No SM positions on this side', weight: 0.8 };
    }

    const totalValue = alignedPositions.reduce((s, p) => s + Math.abs(p.position_value_usd), 0);
    const largestPosition = Math.max(...alignedPositions.map(p => Math.abs(p.position_value_usd)));
    const concentrationPct = totalValue > 0 ? (largestPosition / totalValue) * 100 : 100;
    const walletCount = alignedPositions.length;

    let score: number;
    let label: string;

    if (walletCount >= 8 && concentrationPct < 30) {
      score = 0.7;
      label = `Broad conviction: ${walletCount} wallets, no single wallet dominates (top: ${concentrationPct.toFixed(0)}%)`;
    } else if (walletCount >= 4 && concentrationPct < 50) {
      score = 0.3;
      label = `Reasonable spread: ${walletCount} wallets (top: ${concentrationPct.toFixed(0)}%)`;
    } else if (walletCount >= 2) {
      score = 0;
      label = `Few wallets: ${walletCount} (top: ${concentrationPct.toFixed(0)}%)`;
    } else {
      score = -0.4;
      label = `Single whale dominates (${concentrationPct.toFixed(0)}% of position) — exit risk`;
    }

    return { name: 'Position Concentration', value: concentrationPct, score, label, weight: 0.8 };
  }

  // ─── Data Helpers ───────────────────────────────────────────────────────────

  private async getScreenerData(token: string): Promise<PerpScreenerToken | null> {
    try {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const res = await this.nansenHL.screenPerps({
        date: { from: yesterday.toISOString(), to: now.toISOString() },
        filters: { token_symbol: token },
        pagination: { page: 1, per_page: 1 },
      });
      return res.data[0] ?? null;
    } catch {
      return null;
    }
  }

  private async getPositionData(token: string): Promise<TokenPerpPosition[]> {
    try {
      const res = await this.nansenHL.getTokenPerpPositions({
        token_symbol: token,
        label_type: 'smart_money',
        order_by: [{ field: 'position_value_usd', direction: 'DESC' }],
        pagination: { page: 1, per_page: 50 },
      });
      return res.data;
    } catch {
      return [];
    }
  }
}
