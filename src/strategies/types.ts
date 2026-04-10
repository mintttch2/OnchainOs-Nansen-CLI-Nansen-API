export interface AlphaSignal {
  id: string;
  timestamp: Date;
  type: SignalType;
  strength: SignalStrength;
  confidence: number;
  token: {
    address: string;
    symbol: string;
    chain: string;
  };
  metrics: SignalMetrics;
  action: RecommendedAction;
  reasoning: string;
}

export type SignalType =
  | 'smart_money_accumulation'
  | 'fund_inflow'
  | 'whale_movement'
  | 'volume_spike'
  | 'multi_signal_convergence';

export type SignalStrength = 'weak' | 'moderate' | 'strong' | 'very_strong';

export interface SignalMetrics {
  netFlow24h?: number;
  netFlow7d?: number;
  traderCount?: number;
  holdersCount?: number;
  volumeChange?: number;
  marketCap?: number;
  priceChange24h?: number;
  smartMoneyScore?: number;
}

export type RecommendedAction = 'buy' | 'sell' | 'hold' | 'watch';

export interface StrategyConfig {
  minConfidence: number;
  minTraderCount: number;
  minNetFlowUsd: number;
  maxMarketCapUsd: number;
  minMarketCapUsd: number;
  lookbackHours: number;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  minConfidence: 0.7,
  minTraderCount: 3,
  minNetFlowUsd: 10_000,
  maxMarketCapUsd: 1_000_000_000,
  minMarketCapUsd: 100_000,
  lookbackHours: 24,
};
