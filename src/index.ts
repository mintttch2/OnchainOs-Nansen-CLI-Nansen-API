// NansenOS Alpha Agent
// Combines Nansen Smart Money Intelligence with OKX OnchainOS for on-chain alpha discovery and execution

export { NansenClient } from './nansen/client';
export { OnchainOsClient } from './onchainos/client';
export { AlphaDetector } from './strategies/alpha-detector';
export { TradeExecutor } from './strategies/executor';
export { createNansenSkills } from './agent/skills';
export { loadConfig, validateConfig } from './config';

export type {
  SmartMoneyNetflow,
  SmartMoneyHolding,
  SmartMoneyDexTrade,
  TokenScreenerResult,
  SmartMoneyNetflowRequest,
  SmartMoneyHoldingsRequest,
  TokenScreenerRequest,
} from './nansen/types';

export type {
  SwapQuote,
  SwapResult,
  MarketTokenPrice,
  SkillDefinition,
  SkillResponse,
} from './onchainos/types';

export type {
  AlphaSignal,
  SignalType,
  SignalStrength,
  StrategyConfig,
} from './strategies/types';
