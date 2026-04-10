// ─── Nansen Hyperliquid API Types ───────────────────────────────────────────
// Note: Hyperliquid uses token SYMBOLS (BTC, ETH) not addresses

export type PerpSide = 'Long' | 'Short';
export type PerpAction =
  | 'Buy - Open Long'
  | 'Buy - Add Long'
  | 'Buy - Close Short'
  | 'Buy - Reduce Short'
  | 'Sell - Open Short'
  | 'Sell - Add Short'
  | 'Sell - Close Long'
  | 'Sell - Reduce Long';

export type SmartMoneyHLLabel =
  | 'Fund'
  | 'Smart Trader'
  | 'Smart HL Perps Trader'
  | '30D Smart Trader'
  | '90D Smart Trader'
  | '180D Smart Trader';

export type LabelType = 'smart_money' | 'all_traders' | 'whale' | 'public_figure';

export interface NumericRange {
  min?: number;
  max?: number;
}

export interface SortOrder {
  field: string;
  direction: 'ASC' | 'DESC';
}

export interface PaginationRequest {
  page?: number;
  per_page?: number;
}

export interface PaginationInfo {
  page: number;
  per_page: number;
  is_last_page: boolean;
}

// ─── Smart Money Perp Trades ─────────────────────────────────────────────────

export interface SmartMoneyPerpTradesFilters {
  include_smart_money_labels?: SmartMoneyHLLabel[];
  exclude_smart_money_labels?: SmartMoneyHLLabel[];
  trader_address?: string | string[];
  trader_address_label?: string;
  token_symbol?: string;
  type?: 'Market' | 'Limit';
  token_amount?: NumericRange;
  price_usd?: NumericRange;
  value_usd?: NumericRange;
  side?: PerpSide;
  action?: PerpAction;
}

export interface SmartMoneyPerpTradesRequest {
  filters?: SmartMoneyPerpTradesFilters;
  only_new_positions?: boolean;
  premium_labels?: boolean;
  pagination?: PaginationRequest;
  order_by?: SortOrder[];
}

export interface SmartMoneyPerpTrade {
  trader_address: string;
  trader_address_label: string;
  token_symbol: string;
  side: PerpSide;
  action: PerpAction;
  token_amount: number;
  price_usd: number;
  value_usd: number;
  type: 'Market' | 'Limit';
  block_timestamp: string;
  transaction_hash: string;
}

export interface SmartMoneyPerpTradesResponse {
  data: SmartMoneyPerpTrade[];
  pagination: PaginationInfo;
}

// ─── Perp Screener ───────────────────────────────────────────────────────────

export interface PerpScreenerFilters {
  only_smart_money?: boolean;
  token_symbol?: string;
  volume?: NumericRange;
  buy_volume?: NumericRange;
  sell_volume?: NumericRange;
  buy_sell_pressure?: NumericRange;
  trader_count?: NumericRange;
  mark_price?: NumericRange;
  funding?: NumericRange;
  open_interest?: NumericRange;
  smart_money_volume?: NumericRange;
  smart_money_buy_volume?: NumericRange;
  smart_money_sell_volume?: NumericRange;
  net_position_change?: NumericRange;
  current_smart_money_position_longs_usd?: NumericRange;
  current_smart_money_position_shorts_usd?: NumericRange;
  smart_money_longs_count?: NumericRange;
  smart_money_shorts_count?: NumericRange;
}

export interface PerpScreenerRequest {
  date: { from: string; to: string };
  filters?: PerpScreenerFilters;
  order_by?: SortOrder[];
  pagination?: PaginationRequest;
}

export interface PerpScreenerToken {
  token_symbol: string;
  // General mode
  volume?: number;
  buy_volume?: number;
  sell_volume?: number;
  buy_sell_pressure?: number;
  trader_count?: number;
  mark_price?: number;
  funding?: number;
  open_interest?: number;
  previous_price_usd?: number;
  // Smart money mode
  smart_money_volume?: number;
  smart_money_buy_volume?: number;
  smart_money_sell_volume?: number;
  net_position_change?: number;
  current_smart_money_position_longs_usd?: number;
  current_smart_money_position_shorts_usd?: number;
  smart_money_longs_count?: number;
  smart_money_shorts_count?: number;
}

export interface PerpScreenerResponse {
  data: PerpScreenerToken[];
  pagination: PaginationInfo;
}

// ─── Address Perp Positions ──────────────────────────────────────────────────

export interface AddressPerpPositionsRequest {
  address: string;
  filters?: {
    token_symbol?: string;
    position_value_usd?: NumericRange;
    position_type?: PerpSide;
    unrealized_pnl_usd?: NumericRange;
  };
  order_by?: SortOrder[];
}

export interface PerpPosition {
  token_symbol: string;
  side: PerpSide;
  position_value_usd: number;
  position_size: number;
  leverage: number;
  leverage_type: 'Cross' | 'Isolated';
  entry_price: number;
  mark_price: number;
  liquidation_price: number;
  unrealized_pnl_usd: number;
  funding_usd: number;
  return_on_equity: number;
}

export interface AddressPerpPositionsResponse {
  data: PerpPosition[];
  account: {
    account_value: number;
    withdrawable: number;
    total_margin: number;
  };
}

// ─── Token Perp Positions ────────────────────────────────────────────────────

export interface TokenPerpPositionsRequest {
  token_symbol: string;
  label_type?: LabelType;
  filters?: {
    include_smart_money_labels?: SmartMoneyHLLabel[];
    address?: string | string[];
    side?: PerpSide;
    position_value_usd?: NumericRange;
    position_size?: NumericRange;
    entry_price?: NumericRange;
    upnl_usd?: NumericRange;
  };
  order_by?: SortOrder[];
  pagination?: PaginationRequest;
}

export interface TokenPerpPosition {
  address: string;
  address_label: string;
  side: PerpSide;
  position_value_usd: number;
  position_size: number;
  leverage: number;
  leverage_type: 'Cross' | 'Isolated';
  entry_price: number;
  mark_price: number;
  liquidation_price: number;
  funding_usd: number;
  upnl_usd: number;
}

export interface TokenPerpPositionsResponse {
  data: TokenPerpPosition[];
  pagination: PaginationInfo;
}

// ─── Derived: Sentiment & Copy Signal ───────────────────────────────────────

export interface PerpSentiment {
  token_symbol: string;
  timestamp: Date;
  // Smart money positioning
  smart_money_long_usd: number;
  smart_money_short_usd: number;
  long_short_ratio: number;        // >1 = more longs, <1 = more shorts
  net_position_usd: number;        // positive = net long, negative = net short
  smart_money_longs_count: number;
  smart_money_shorts_count: number;
  // Flow data (last 24h)
  net_flow_24h_usd: number;        // positive = net buying pressure
  buy_pressure_pct: number;        // 0-100%
  // Derived signal
  signal: 'strong_long' | 'lean_long' | 'neutral' | 'lean_short' | 'strong_short';
  confidence: number;              // 0-1
  reasoning: string;
}

export interface CopyTradeSetup {
  source_trader: string;
  source_label: string;
  token_symbol: string;
  side: PerpSide;
  suggested_leverage: number;
  entry_context: string;
  trader_unrealized_pnl_usd: number;
  trader_position_value_usd: number;
  liquidation_price: number;
  risk_note: string;
}
