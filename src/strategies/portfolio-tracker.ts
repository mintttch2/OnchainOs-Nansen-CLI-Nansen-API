import fs from 'fs';
import path from 'path';
import { PerpSide } from '../nansen/hyperliquid-types';
import { logger } from '../utils/logger';
import { formatUsd } from '../utils/formatting';

/**
 * Portfolio Tracker — Logs every trade and computes running statistics.
 * Persists to a JSON file so stats survive restarts.
 */

export interface TradeRecord {
  id: string;
  token: string;
  side: PerpSide;
  sizeUsd: number;
  leverage: number;
  entryPrice: number;
  exitPrice: number | null;
  entryTime: string;              // ISO
  exitTime: string | null;
  exitReason: string | null;
  pnlUsd: number;
  pnlPct: number;
  signalScore: number;
  fees: number;
  status: 'open' | 'closed';
}

export interface PortfolioStats {
  totalTrades: number;
  openPositions: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number;                // 0-100%
  totalPnlUsd: number;
  avgPnlUsd: number;
  avgPnlPct: number;
  bestTradeUsd: number;
  worstTradeUsd: number;
  maxDrawdownPct: number;
  profitFactor: number;           // gross profit / gross loss
  avgHoldTimeMinutes: number;
  sharpeApprox: number;           // simple Sharpe approximation
}

const DEFAULT_LOG_PATH = path.resolve(process.cwd(), '.hypernansen-trades.json');

export class PortfolioTracker {
  private trades: TradeRecord[] = [];
  private logPath: string;
  private peakEquity = 0;
  private currentDrawdown = 0;
  private maxDrawdown = 0;

  constructor(logPath?: string) {
    this.logPath = logPath ?? DEFAULT_LOG_PATH;
    this.load();
  }

  /** Record a new trade entry */
  recordEntry(trade: Omit<TradeRecord, 'exitPrice' | 'exitTime' | 'exitReason' | 'pnlUsd' | 'pnlPct' | 'status'>): void {
    this.trades.push({
      ...trade,
      exitPrice: null,
      exitTime: null,
      exitReason: null,
      pnlUsd: 0,
      pnlPct: 0,
      status: 'open',
    });
    this.save();
    logger.trade(`OPEN ${trade.side} ${trade.token} ${formatUsd(trade.sizeUsd)} @ $${trade.entryPrice.toFixed(2)} ${trade.leverage}x [score: ${trade.signalScore}]`);
  }

  /** Record a trade exit */
  recordExit(tradeId: string, exitPrice: number, exitReason: string, fees = 0): void {
    const trade = this.trades.find(t => t.id === tradeId && t.status === 'open');
    if (!trade) {
      logger.warn(`Trade ${tradeId} not found or already closed`);
      return;
    }

    trade.exitPrice = exitPrice;
    trade.exitTime = new Date().toISOString();
    trade.exitReason = exitReason;
    trade.fees += fees;
    trade.status = 'closed';

    // Compute PnL
    if (trade.side === 'Long') {
      trade.pnlPct = ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100 * trade.leverage;
    } else {
      trade.pnlPct = ((trade.entryPrice - exitPrice) / trade.entryPrice) * 100 * trade.leverage;
    }
    trade.pnlUsd = (trade.pnlPct / 100) * trade.sizeUsd - trade.fees;

    this.updateDrawdown(trade.pnlUsd);
    this.save();

    const pnlColor = trade.pnlUsd >= 0 ? '+' : '';
    logger.trade(`CLOSE ${trade.side} ${trade.token} — ${pnlColor}${formatUsd(trade.pnlUsd)} (${trade.pnlPct.toFixed(2)}%) [${exitReason}]`);
  }

  /** Get an open trade by token */
  getOpenTrade(token: string): TradeRecord | undefined {
    return this.trades.find(t => t.token === token && t.status === 'open');
  }

  /** Get all open trades */
  getOpenTrades(): TradeRecord[] {
    return this.trades.filter(t => t.status === 'open');
  }

  /** Compute portfolio stats */
  getStats(): PortfolioStats {
    const closed = this.trades.filter(t => t.status === 'closed');
    const open = this.trades.filter(t => t.status === 'open');
    const wins = closed.filter(t => t.pnlUsd > 0);
    const losses = closed.filter(t => t.pnlUsd <= 0);

    const totalPnl = closed.reduce((s, t) => s + t.pnlUsd, 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnlUsd, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0));

    const avgHoldTime = closed.length > 0
      ? closed.reduce((s, t) => {
        const entry = new Date(t.entryTime).getTime();
        const exit = new Date(t.exitTime!).getTime();
        return s + (exit - entry);
      }, 0) / closed.length / 60_000
      : 0;

    // Simple Sharpe approximation: mean return / stddev of returns
    const returns = closed.map(t => t.pnlPct);
    const meanReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const variance = returns.length > 1
      ? returns.reduce((s, r) => s + Math.pow(r - meanReturn, 2), 0) / (returns.length - 1)
      : 0;
    const stddev = Math.sqrt(variance);
    const sharpe = stddev > 0 ? meanReturn / stddev : 0;

    return {
      totalTrades: this.trades.length,
      openPositions: open.length,
      closedTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
      totalPnlUsd: totalPnl,
      avgPnlUsd: closed.length > 0 ? totalPnl / closed.length : 0,
      avgPnlPct: meanReturn,
      bestTradeUsd: closed.length > 0 ? Math.max(...closed.map(t => t.pnlUsd)) : 0,
      worstTradeUsd: closed.length > 0 ? Math.min(...closed.map(t => t.pnlUsd)) : 0,
      maxDrawdownPct: this.maxDrawdown,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      avgHoldTimeMinutes: avgHoldTime,
      sharpeApprox: sharpe,
    };
  }

  /** Get formatted summary string */
  getSummary(): string {
    const s = this.getStats();
    const lines = [
      `Trades: ${s.closedTrades} closed, ${s.openPositions} open`,
      `Win rate: ${s.winRate.toFixed(1)}% (${s.wins}W / ${s.losses}L)`,
      `Total PnL: ${formatUsd(s.totalPnlUsd)}`,
      `Avg PnL: ${formatUsd(s.avgPnlUsd)} (${s.avgPnlPct.toFixed(2)}%)`,
      `Best: ${formatUsd(s.bestTradeUsd)} | Worst: ${formatUsd(s.worstTradeUsd)}`,
      `Max Drawdown: ${s.maxDrawdownPct.toFixed(2)}%`,
      `Profit Factor: ${s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)}`,
      `Avg Hold: ${s.avgHoldTimeMinutes.toFixed(0)}m`,
      `Sharpe: ${s.sharpeApprox.toFixed(2)}`,
    ];
    return lines.join('\n');
  }

  /** Get all trades for export */
  getAllTrades(): TradeRecord[] {
    return [...this.trades];
  }

  /** Clear all data (use with caution) */
  reset(): void {
    this.trades = [];
    this.peakEquity = 0;
    this.currentDrawdown = 0;
    this.maxDrawdown = 0;
    this.save();
    logger.warn('Portfolio tracker reset');
  }

  // ─── Persistence ────────────────────────────────────────────────────────────

  private save(): void {
    try {
      const data = {
        trades: this.trades,
        peakEquity: this.peakEquity,
        maxDrawdown: this.maxDrawdown,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(this.logPath, JSON.stringify(data, null, 2));
    } catch (err) {
      logger.error(`Failed to save portfolio: ${err}`);
    }
  }

  private load(): void {
    try {
      if (fs.existsSync(this.logPath)) {
        const raw = fs.readFileSync(this.logPath, 'utf-8');
        const data = JSON.parse(raw);
        this.trades = data.trades || [];
        this.peakEquity = data.peakEquity || 0;
        this.maxDrawdown = data.maxDrawdown || 0;
        logger.info(`Loaded ${this.trades.length} trades from ${this.logPath}`);
      }
    } catch (err) {
      logger.warn(`Failed to load portfolio log: ${err}`);
      this.trades = [];
    }
  }

  private updateDrawdown(pnl: number): void {
    this.currentDrawdown += pnl;
    if (this.currentDrawdown > 0) {
      this.peakEquity += this.currentDrawdown;
      this.currentDrawdown = 0;
    }
    if (this.peakEquity > 0) {
      const dd = Math.abs(this.currentDrawdown) / this.peakEquity * 100;
      if (dd > this.maxDrawdown) {
        this.maxDrawdown = dd;
      }
    }
  }
}
