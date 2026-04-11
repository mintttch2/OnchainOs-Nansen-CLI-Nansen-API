/**
 * HyperNansen — Hyperliquid Smart Money Intelligence
 * Nansen Smart Money Data × OKX OnchainOS Hyperliquid Plugin
 *
 * Built for OKX Build X Hackathon 2026
 * Tracks: Skills Arena + X Layer Arena
 */

// ─── Phase 2: Hyperliquid Core (primary exports) ─────────────────────────────

export { NansenHyperliquidClient } from './nansen/hyperliquid-client';
export { OnchainOsHyperliquidClient } from './onchainos/hyperliquid-client';
export { createHyperliquidSkills } from './agent/hyperliquid-skills';
export { loadConfig, validateConfig } from './config';

export type {
  PerpSide,
  SmartMoneyHLLabel,
  PerpSentiment,
  CopyTradeSetup,
  SmartMoneyPerpTrade,
  SmartMoneyPerpTradesRequest,
  SmartMoneyPerpTradesResponse,
  PerpScreenerToken,
  PerpScreenerRequest,
  PerpScreenerResponse,
  PerpPosition,
  TokenPerpPositionsRequest,
  TokenPerpPositionsResponse,
  AddressPerpPositionsRequest,
  AddressPerpPositionsResponse,
} from './nansen/hyperliquid-types';

export type {
  HLSide,
  HLOrderType,
  HLPlaceOrderRequest,
  HLOrderResult,
  HLClosePositionRequest,
  HLSetLeverageRequest,
  HLAccountSummary,
} from './onchainos/hyperliquid-client';

export type {
  SkillDefinition,
  SkillResponse,
} from './onchainos/types';

// ─── Auto-Trader Engine ──────────────────────────────────────────────────────

export { SmartMoneyAutoTrader } from './strategies/auto-trader';
export { SignalScorer } from './strategies/signal-scorer';
export { RiskManager } from './strategies/risk-manager';
export { PortfolioTracker } from './strategies/portfolio-tracker';

export type { ScoredOpportunity, ScoreBreakdown } from './strategies/signal-scorer';
export type { RiskConfig, RiskLevel, ActivePosition } from './strategies/risk-manager';
export type { TradeRecord, PortfolioStats } from './strategies/portfolio-tracker';
export type { AutoTraderConfig, CycleResult } from './strategies/auto-trader';

// ─── Smart Money Copy Engine ─────────────────────────────────────────────────

export { SmartMoneyCopyEngine } from './strategies/copy-engine';
export { TraderProfiler } from './strategies/trader-profiler';
export { MarketAnalyzer } from './strategies/market-analyzer';

export type { CopyEngineConfig, CopyDecision, CopyCycleResult } from './strategies/copy-engine';
export type { TraderProfile, NewTraderMove, Timeframe } from './strategies/trader-profiler';
export type { MarketCondition, IndicatorResult } from './strategies/market-analyzer';
