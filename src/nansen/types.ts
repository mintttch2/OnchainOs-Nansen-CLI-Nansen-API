// ─── Smart Money Types ───

export type SmartMoneyLabel =
  | 'Fund'
  | 'Smart Trader'
  | 'Whale'
  | 'Institution'
  | 'Insider'
  | 'Airdrop Pro';

export interface NumericRange {
  min?: number;
  max?: number;
}

export interface SmartMoneyNetflowFilters {
  include_smart_money_labels?: SmartMoneyLabel[];
  exclude_smart_money_labels?: SmartMoneyLabel[];
  token_address?: string;
  include_stablecoins?: boolean;
  include_native_tokens?: boolean;
  token_sector?: string[];
  trader_count?: NumericRange;
  token_age_days?: NumericRange;
  market_cap_usd?: NumericRange;
}

export interface OrderBy {
  field: string;
  direction: 'ASC' | 'DESC';
}

export interface Pagination {
  page: number;
  per_page: number;
}

export interface SmartMoneyNetflowRequest {
  chains: string[] | 'all';
  filters?: SmartMoneyNetflowFilters;
  order_by?: OrderBy[];
  pagination?: Pagination;
  premium_labels?: boolean;
}

export interface SmartMoneyNetflow {
  token_address: string;
  token_symbol: string;
  chain: string;
  net_flow_1h_usd: number;
  net_flow_24h_usd: number;
  net_flow_7d_usd: number;
  net_flow_30d_usd: number;
  token_sectors: string[];
  trader_count: number;
  token_age_days: number;
  market_cap_usd: number;
}

export interface PaginationInfo {
  page: number;
  per_page: number;
  is_last_page: boolean;
}

export interface SmartMoneyNetflowResponse {
  data: SmartMoneyNetflow[];
  pagination: PaginationInfo;
}

// ─── Smart Money Holdings Types ───

export interface SmartMoneyHoldingsRequest {
  chains: string[] | 'all';
  filters?: Record<string, unknown>;
  order_by?: OrderBy[];
  pagination?: Pagination;
  premium_labels?: boolean;
}

export interface SmartMoneyHolding {
  chain: string;
  token_address: string;
  token_symbol: string;
  value_usd: number;
  balance_24h_percent_change: number;
  holders_count: number;
  market_cap_usd: number;
  token_age_days: number;
  token_sectors: string[];
}

export interface SmartMoneyHoldingsResponse {
  data: SmartMoneyHolding[];
  pagination: PaginationInfo;
}

// ─── Smart Money DEX Trades Types ───

export interface SmartMoneyDexTradesRequest {
  chains: string[] | 'all';
  filters?: Record<string, unknown>;
  order_by?: OrderBy[];
  pagination?: Pagination;
}

export interface SmartMoneyDexTrade {
  chain: string;
  token_address: string;
  token_symbol: string;
  buy_volume_usd: number;
  sell_volume_usd: number;
  net_volume_usd: number;
  buyer_count: number;
  seller_count: number;
  market_cap_usd: number;
}

export interface SmartMoneyDexTradesResponse {
  data: SmartMoneyDexTrade[];
  pagination: PaginationInfo;
}

// ─── Token Screener Types ───

export type Timeframe = '5m' | '10m' | '1h' | '6h' | '24h' | '7d' | '30d';

export interface TokenScreenerRequest {
  chains: string[];
  timeframe?: Timeframe;
  filters?: Record<string, unknown>;
  order_by?: OrderBy[];
  pagination?: Pagination;
}

export interface TokenScreenerResult {
  chain: string;
  token_address: string;
  token_symbol: string;
  market_cap_usd: number;
  liquidity_usd: number;
  price_usd: number;
  price_change_percent: number;
  volume_usd: number;
  buy_volume_usd: number;
  sell_volume_usd: number;
  net_flow_usd: number;
  trader_count: number;
}

export interface TokenScreenerResponse {
  data: TokenScreenerResult[];
  pagination: PaginationInfo;
}

// ─── Agent Types ───

export interface NansenAgentRequest {
  prompt: string;
  context?: Record<string, unknown>;
}

export interface NansenAgentResponse {
  answer: string;
  sources: string[];
  confidence: number;
}
