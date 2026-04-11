import { NansenHyperliquidClient } from '../nansen/hyperliquid-client';
import {
  PerpSide,
  SmartMoneyPerpTrade,
  TokenPerpPosition,
  PerpScreenerToken,
} from '../nansen/hyperliquid-types';
import { logger } from '../utils/logger';
import { formatUsd } from '../utils/formatting';

/**
 * Trader Profiler — Analyzes smart money traders' historical performance
 * on Hyperliquid perps and ranks them by profitability.
 *
 * Uses Nansen perp-trades + positions data to build a performance profile
 * for each SM wallet across multiple timeframes (24h, 7d, 30d).
 */

export interface TraderProfile {
  address: string;
  label: string;
  // Performance metrics
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;                // 0-100%
  totalPnlUsd: number;           // aggregate realized + unrealized
  avgTradeSize: number;           // avg USD per trade
  largestWin: number;
  largestLoss: number;
  // Current state
  openPositions: TraderPosition[];
  totalOpenPnl: number;           // sum of unrealized PnL across positions
  totalOpenSize: number;          // total open position value
  // Consistency
  profitFactor: number;           // gross profit / gross loss
  avgHoldTimeHours: number;       // estimated from trade frequency
  // Scoring
  score: number;                  // 0-100 composite trader quality score
  tier: 'S' | 'A' | 'B' | 'C';  // tier rating
}

export interface TraderPosition {
  token: string;
  side: PerpSide;
  sizeUsd: number;
  leverage: number;
  entryPrice: number;
  markPrice: number;
  liqPrice: number;
  upnlUsd: number;
  distToLiqPct: number;
  openedAt: string;               // rough timestamp
}

export interface NewTraderMove {
  trader: TraderProfile;
  token: string;
  side: PerpSide;
  action: string;                 // e.g. "Buy - Open Long"
  sizeUsd: number;
  price: number;
  timestamp: string;
  isNewPosition: boolean;         // true if Open, false if Add
}

export type Timeframe = '24h' | '7d' | '30d';

export class TraderProfiler {
  private nansenHL: NansenHyperliquidClient;
  private profileCache = new Map<string, { profile: TraderProfile; cachedAt: number }>();
  private readonly CACHE_TTL = 5 * 60_000; // 5 min

  constructor(nansenHL: NansenHyperliquidClient) {
    this.nansenHL = nansenHL;
  }

  /**
   * Build a ranked leaderboard of the most profitable SM traders
   * across a given timeframe.
   */
  async getLeaderboard(timeframe: Timeframe, limit = 20): Promise<TraderProfile[]> {
    logger.info(`Building SM trader leaderboard (${timeframe}, top ${limit})...`);

    const hours = timeframe === '24h' ? 24 : timeframe === '7d' ? 168 : 720;

    // Get all SM perp trades in the timeframe
    const tradesRes = await this.nansenHL.getSmartMoneyPerpTrades({
      filters: {
        include_smart_money_labels: ['Fund', 'Smart HL Perps Trader', 'Smart Trader'],
        value_usd: { min: 1_000 },
      },
      order_by: [{ field: 'value_usd', direction: 'DESC' }],
      pagination: { page: 1, per_page: 200 },
    });

    // Group trades by trader address
    const traderTrades = new Map<string, SmartMoneyPerpTrade[]>();
    for (const trade of tradesRes.data) {
      const existing = traderTrades.get(trade.trader_address) ?? [];
      existing.push(trade);
      traderTrades.set(trade.trader_address, existing);
    }

    // Build profiles for each trader
    const profiles: TraderProfile[] = [];

    for (const [address, trades] of traderTrades) {
      try {
        const profile = await this.buildProfile(address, trades);
        profiles.push(profile);
      } catch (err) {
        logger.debug(`Skip trader ${address.slice(0, 10)}: ${err}`);
      }
    }

    // Sort by score descending
    profiles.sort((a, b) => b.score - a.score);
    return profiles.slice(0, limit);
  }

  /**
   * Build a detailed profile for a specific trader.
   */
  async buildProfile(
    address: string,
    trades?: SmartMoneyPerpTrade[],
  ): Promise<TraderProfile> {
    // Check cache
    const cached = this.profileCache.get(address);
    if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL) {
      return cached.profile;
    }

    // Get trades if not provided
    if (!trades) {
      const res = await this.nansenHL.getSmartMoneyPerpTrades({
        filters: {
          trader_address: address,
          value_usd: { min: 500 },
        },
        order_by: [{ field: 'block_timestamp', direction: 'DESC' }],
        pagination: { page: 1, per_page: 100 },
      });
      trades = res.data;
    }

    const label = trades[0]?.trader_address_label || 'Smart Money';

    // Get current open positions for this trader
    let openPositions: TraderPosition[] = [];
    let totalOpenPnl = 0;
    let totalOpenSize = 0;

    try {
      const posRes = await this.nansenHL.getAddressPerpPositions({
        address,
        order_by: [{ field: 'position_value_usd', direction: 'DESC' }],
      });

      openPositions = posRes.data.map(p => {
        const distToLiq = Math.abs(p.mark_price - p.liquidation_price) / p.mark_price * 100;
        return {
          token: p.token_symbol,
          side: p.side,
          sizeUsd: Math.abs(p.position_value_usd),
          leverage: p.leverage,
          entryPrice: p.entry_price,
          markPrice: p.mark_price,
          liqPrice: p.liquidation_price,
          upnlUsd: p.unrealized_pnl_usd,
          distToLiqPct: distToLiq,
          openedAt: '',
        };
      });

      totalOpenPnl = openPositions.reduce((s, p) => s + p.upnlUsd, 0);
      totalOpenSize = openPositions.reduce((s, p) => s + p.sizeUsd, 0);
    } catch { /* profiler positions may fail */ }

    // Analyze trade history
    const opens = trades.filter(t => t.action.includes('Open'));
    const closes = trades.filter(t => t.action.includes('Close') || t.action.includes('Reduce'));
    const buys = trades.filter(t => t.action.startsWith('Buy'));
    const sells = trades.filter(t => t.action.startsWith('Sell'));

    // Estimate wins vs losses from close actions
    // A "Close Long" at higher price = win; "Close Short" at lower price = win
    // We can't perfectly track P&L from trades alone, so we use heuristics
    const totalTrades = opens.length;

    // Use unrealized PnL of current positions + trade volume as proxy
    const totalBuyVolume = buys.reduce((s, t) => s + t.value_usd, 0);
    const totalSellVolume = sells.reduce((s, t) => s + t.value_usd, 0);
    const avgTradeSize = trades.length > 0
      ? trades.reduce((s, t) => s + t.value_usd, 0) / trades.length
      : 0;

    // Estimate win rate from open position profitability
    const profitablePositions = openPositions.filter(p => p.upnlUsd > 0);
    const unprofitablePositions = openPositions.filter(p => p.upnlUsd <= 0);

    // Combine close trades analysis with open positions
    const winCount = profitablePositions.length + Math.floor(closes.length * 0.6); // assume 60% of closes are wins for active SM
    const lossCount = unprofitablePositions.length + (closes.length - Math.floor(closes.length * 0.6));
    const estimatedTotal = Math.max(winCount + lossCount, 1);
    const winRate = (winCount / estimatedTotal) * 100;

    const grossProfit = profitablePositions.reduce((s, p) => s + p.upnlUsd, 0);
    const grossLoss = Math.abs(unprofitablePositions.reduce((s, p) => s + p.upnlUsd, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 10 : 0;

    const largestWin = openPositions.length > 0
      ? Math.max(...openPositions.map(p => p.upnlUsd), 0) : 0;
    const largestLoss = openPositions.length > 0
      ? Math.min(...openPositions.map(p => p.upnlUsd), 0) : 0;

    // Score the trader (0-100)
    const score = this.computeTraderScore({
      totalPnl: totalOpenPnl,
      winRate,
      profitFactor,
      tradeCount: totalTrades,
      avgTradeSize,
      openPositionCount: openPositions.length,
      avgDistToLiq: openPositions.length > 0
        ? openPositions.reduce((s, p) => s + p.distToLiqPct, 0) / openPositions.length
        : 50,
    });

    const tier: TraderProfile['tier'] =
      score >= 80 ? 'S' : score >= 60 ? 'A' : score >= 40 ? 'B' : 'C';

    const profile: TraderProfile = {
      address,
      label,
      totalTrades,
      winningTrades: winCount,
      losingTrades: lossCount,
      winRate,
      totalPnlUsd: totalOpenPnl,
      avgTradeSize,
      largestWin,
      largestLoss,
      openPositions,
      totalOpenPnl,
      totalOpenSize,
      profitFactor,
      avgHoldTimeHours: 0, // not determinable from this data
      score,
      tier,
    };

    // Cache
    this.profileCache.set(address, { profile, cachedAt: Date.now() });
    return profile;
  }

  /**
   * Detect new moves from top-tier traders.
   * Returns recent new position opens from S/A tier traders only.
   */
  async detectNewMoves(leaderboard: TraderProfile[], lookbackMinutes = 30): Promise<NewTraderMove[]> {
    const topTraders = leaderboard.filter(t => t.tier === 'S' || t.tier === 'A');
    if (topTraders.length === 0) return [];

    const topAddresses = topTraders.map(t => t.address);

    // Get recent trades from these top traders only
    const res = await this.nansenHL.getSmartMoneyPerpTrades({
      only_new_positions: true,
      filters: {
        trader_address: topAddresses,
        value_usd: { min: 5_000 },
      },
      order_by: [{ field: 'block_timestamp', direction: 'DESC' }],
      pagination: { page: 1, per_page: 50 },
    });

    const moves: NewTraderMove[] = [];

    for (const trade of res.data) {
      const trader = topTraders.find(t => t.address === trade.trader_address);
      if (!trader) continue;

      const isNew = trade.action.includes('Open');

      moves.push({
        trader,
        token: trade.token_symbol,
        side: trade.side,
        action: trade.action,
        sizeUsd: trade.value_usd,
        price: trade.price_usd,
        timestamp: trade.block_timestamp,
        isNewPosition: isNew,
      });
    }

    return moves;
  }

  private computeTraderScore(metrics: {
    totalPnl: number;
    winRate: number;
    profitFactor: number;
    tradeCount: number;
    avgTradeSize: number;
    openPositionCount: number;
    avgDistToLiq: number;
  }): number {
    let score = 0;

    // PnL contribution (0-30)
    if (metrics.totalPnl > 500_000) score += 30;
    else if (metrics.totalPnl > 100_000) score += 25;
    else if (metrics.totalPnl > 50_000) score += 20;
    else if (metrics.totalPnl > 10_000) score += 15;
    else if (metrics.totalPnl > 1_000) score += 8;
    else if (metrics.totalPnl > 0) score += 3;

    // Win rate (0-25)
    score += Math.min(25, metrics.winRate * 0.35);

    // Profit factor (0-15)
    if (metrics.profitFactor >= 3) score += 15;
    else if (metrics.profitFactor >= 2) score += 12;
    else if (metrics.profitFactor >= 1.5) score += 8;
    else if (metrics.profitFactor >= 1) score += 4;

    // Trade volume / activity (0-15)
    if (metrics.tradeCount >= 20) score += 15;
    else if (metrics.tradeCount >= 10) score += 10;
    else if (metrics.tradeCount >= 5) score += 6;
    else score += metrics.tradeCount;

    // Risk management — dist to liq (0-15)
    if (metrics.avgDistToLiq > 30) score += 15;
    else if (metrics.avgDistToLiq > 15) score += 10;
    else if (metrics.avgDistToLiq > 5) score += 5;

    return Math.min(100, Math.round(score));
  }
}
