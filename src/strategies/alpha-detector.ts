import { NansenClient } from '../nansen/client';
import { SmartMoneyNetflow, SmartMoneyHolding, SmartMoneyDexTrade } from '../nansen/types';
import { logger } from '../utils/logger';
import { formatUsd } from '../utils/formatting';
import {
  AlphaSignal,
  SignalStrength,
  StrategyConfig,
  DEFAULT_STRATEGY_CONFIG,
} from './types';

export class AlphaDetector {
  private nansen: NansenClient;
  private config: StrategyConfig;

  constructor(nansen: NansenClient, config?: Partial<StrategyConfig>) {
    this.nansen = nansen;
    this.config = { ...DEFAULT_STRATEGY_CONFIG, ...config };
  }

  async detectSignals(chains: string[] | 'all' = 'all'): Promise<AlphaSignal[]> {
    logger.info('Running alpha detection scan...');

    const [netflows, holdings, dexTrades] = await Promise.all([
      this.nansen.getSmartMoneyNetflows({
        chains,
        filters: { include_stablecoins: false, include_native_tokens: false },
        order_by: [{ field: 'net_flow_24h_usd', direction: 'DESC' }],
        pagination: { page: 1, per_page: 50 },
      }),
      this.nansen.getSmartMoneyHoldings({
        chains,
        order_by: [{ field: 'value_usd', direction: 'DESC' }],
        pagination: { page: 1, per_page: 50 },
      }),
      this.nansen.getSmartMoneyDexTrades({
        chains,
        order_by: [{ field: 'net_volume_usd', direction: 'DESC' }],
        pagination: { page: 1, per_page: 50 },
      }),
    ]);

    const signals: AlphaSignal[] = [];

    // Strategy 1: Smart Money Accumulation (strong net inflows + multiple traders)
    for (const flow of netflows.data) {
      const signal = this.analyzeNetflow(flow);
      if (signal) signals.push(signal);
    }

    // Strategy 2: Fund Conviction (top holdings by funds)
    for (const holding of holdings.data) {
      const signal = this.analyzeHolding(holding);
      if (signal) signals.push(signal);
    }

    // Strategy 3: DEX Buy Pressure (net buy volume from smart money)
    for (const trade of dexTrades.data) {
      const signal = this.analyzeDexTrade(trade);
      if (signal) signals.push(signal);
    }

    // Strategy 4: Multi-signal convergence
    const converged = this.detectConvergence(signals);
    signals.push(...converged);

    // Sort by confidence, then strength
    signals.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return strengthRank(b.strength) - strengthRank(a.strength);
    });

    logger.info(`Alpha scan complete: ${signals.length} signals detected`);
    return signals;
  }

  private analyzeNetflow(flow: SmartMoneyNetflow): AlphaSignal | null {
    const { net_flow_24h_usd, net_flow_7d_usd, trader_count, market_cap_usd } = flow;

    if (net_flow_24h_usd < this.config.minNetFlowUsd) return null;
    if (trader_count < this.config.minTraderCount) return null;
    if (market_cap_usd > this.config.maxMarketCapUsd) return null;
    if (market_cap_usd < this.config.minMarketCapUsd) return null;

    // Score calculation
    const flowScore = Math.min(net_flow_24h_usd / 500_000, 1);
    const traderScore = Math.min(trader_count / 20, 1);
    const consistencyScore = net_flow_7d_usd > 0 ? Math.min(net_flow_7d_usd / 1_000_000, 1) : 0;
    const capScore = market_cap_usd < 50_000_000 ? 0.3 : market_cap_usd < 200_000_000 ? 0.2 : 0.1;

    const confidence = flowScore * 0.35 + traderScore * 0.25 + consistencyScore * 0.25 + capScore * 0.15;

    if (confidence < this.config.minConfidence) return null;

    const strength = getStrength(confidence);

    return {
      id: `netflow-${flow.chain}-${flow.token_address}`,
      timestamp: new Date(),
      type: 'smart_money_accumulation',
      strength,
      confidence,
      token: {
        address: flow.token_address,
        symbol: flow.token_symbol,
        chain: flow.chain,
      },
      metrics: {
        netFlow24h: net_flow_24h_usd,
        netFlow7d: net_flow_7d_usd,
        traderCount: trader_count,
        marketCap: market_cap_usd,
      },
      action: confidence > 0.85 ? 'buy' : 'watch',
      reasoning: `Smart money net inflow of ${formatUsd(net_flow_24h_usd)} (24h) from ${trader_count} traders. ` +
        `7d flow: ${formatUsd(net_flow_7d_usd)}. Market cap: ${formatUsd(market_cap_usd)}.`,
    };
  }

  private analyzeHolding(holding: SmartMoneyHolding): AlphaSignal | null {
    const { value_usd, balance_24h_percent_change, holders_count, market_cap_usd } = holding;

    if (balance_24h_percent_change <= 5) return null;
    if (holders_count < this.config.minTraderCount) return null;
    if (market_cap_usd > this.config.maxMarketCapUsd) return null;

    const growthScore = Math.min(balance_24h_percent_change / 50, 1);
    const holdersScore = Math.min(holders_count / 30, 1);
    const valueScore = Math.min(value_usd / 5_000_000, 1);

    const confidence = growthScore * 0.4 + holdersScore * 0.3 + valueScore * 0.3;

    if (confidence < this.config.minConfidence) return null;

    return {
      id: `holding-${holding.chain}-${holding.token_address}`,
      timestamp: new Date(),
      type: 'fund_inflow',
      strength: getStrength(confidence),
      confidence,
      token: {
        address: holding.token_address,
        symbol: holding.token_symbol,
        chain: holding.chain,
      },
      metrics: {
        holdersCount: holders_count,
        marketCap: market_cap_usd,
        priceChange24h: balance_24h_percent_change,
        smartMoneyScore: value_usd,
      },
      action: confidence > 0.85 ? 'buy' : 'watch',
      reasoning: `Smart money holdings increased ${balance_24h_percent_change.toFixed(1)}% (24h). ` +
        `${holders_count} smart money wallets hold ${formatUsd(value_usd)} total.`,
    };
  }

  private analyzeDexTrade(trade: SmartMoneyDexTrade): AlphaSignal | null {
    const { net_volume_usd, buyer_count, seller_count, market_cap_usd } = trade;

    if (net_volume_usd < this.config.minNetFlowUsd) return null;
    if (buyer_count < this.config.minTraderCount) return null;
    if (market_cap_usd > this.config.maxMarketCapUsd) return null;

    const buyPressure = buyer_count / Math.max(seller_count, 1);
    const volumeScore = Math.min(net_volume_usd / 500_000, 1);
    const pressureScore = Math.min(buyPressure / 5, 1);

    const confidence = volumeScore * 0.5 + pressureScore * 0.5;

    if (confidence < this.config.minConfidence) return null;

    return {
      id: `dex-${trade.chain}-${trade.token_address}`,
      timestamp: new Date(),
      type: 'whale_movement',
      strength: getStrength(confidence),
      confidence,
      token: {
        address: trade.token_address,
        symbol: trade.token_symbol,
        chain: trade.chain,
      },
      metrics: {
        netFlow24h: net_volume_usd,
        traderCount: buyer_count,
        marketCap: market_cap_usd,
        volumeChange: net_volume_usd,
      },
      action: confidence > 0.85 ? 'buy' : 'watch',
      reasoning: `Smart money DEX net buy volume: ${formatUsd(net_volume_usd)}. ` +
        `Buy/sell ratio: ${buyer_count}/${seller_count}. Market cap: ${formatUsd(market_cap_usd)}.`,
    };
  }

  private detectConvergence(signals: AlphaSignal[]): AlphaSignal[] {
    const tokenMap = new Map<string, AlphaSignal[]>();

    for (const signal of signals) {
      const key = `${signal.token.chain}-${signal.token.address}`;
      const existing = tokenMap.get(key) || [];
      existing.push(signal);
      tokenMap.set(key, existing);
    }

    const converged: AlphaSignal[] = [];

    for (const [, tokenSignals] of tokenMap) {
      if (tokenSignals.length < 2) continue;

      const avgConfidence = tokenSignals.reduce((sum, s) => sum + s.confidence, 0) / tokenSignals.length;
      const boostedConfidence = Math.min(avgConfidence * 1.2, 1.0);
      const base = tokenSignals[0];

      converged.push({
        id: `converge-${base.token.chain}-${base.token.address}`,
        timestamp: new Date(),
        type: 'multi_signal_convergence',
        strength: getStrength(boostedConfidence),
        confidence: boostedConfidence,
        token: base.token,
        metrics: mergeMetrics(tokenSignals),
        action: boostedConfidence > 0.8 ? 'buy' : 'watch',
        reasoning: `Multi-signal convergence: ${tokenSignals.length} independent signals detected ` +
          `(${tokenSignals.map(s => s.type).join(', ')}). Boosted confidence: ${(boostedConfidence * 100).toFixed(1)}%.`,
      });
    }

    return converged;
  }
}

function getStrength(confidence: number): SignalStrength {
  if (confidence >= 0.9) return 'very_strong';
  if (confidence >= 0.75) return 'strong';
  if (confidence >= 0.6) return 'moderate';
  return 'weak';
}

function strengthRank(s: SignalStrength): number {
  const ranks: Record<SignalStrength, number> = { weak: 0, moderate: 1, strong: 2, very_strong: 3 };
  return ranks[s];
}

function mergeMetrics(signals: AlphaSignal[]): AlphaSignal['metrics'] {
  const merged: AlphaSignal['metrics'] = {};
  for (const signal of signals) {
    Object.assign(merged, signal.metrics);
  }
  return merged;
}
