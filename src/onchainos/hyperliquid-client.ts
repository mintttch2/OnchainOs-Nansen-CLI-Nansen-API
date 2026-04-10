import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { logger } from '../utils/logger';

/**
 * OnchainOS Hyperliquid Plugin Client
 * Integrates with the OKX OnchainOS Hyperliquid plugin for perp trade execution.
 * Ref: https://web3.okx.com/onchainos/plugins/detail/hyperliquid
 */

export type HLOrderType = 'Market' | 'Limit';
export type HLSide = 'Long' | 'Short';
export type HLTimeInForce = 'GoodTilCanceled' | 'ImmediateOrCancel' | 'FillOrKill';

export interface HLPlaceOrderRequest {
  token_symbol: string;            // e.g. "BTC", "ETH", "SOL"
  side: HLSide;
  order_type: HLOrderType;
  size_usd: number;                // position size in USD
  leverage: number;                // 1-50x
  limit_price?: number;            // required for Limit orders
  reduce_only?: boolean;
  time_in_force?: HLTimeInForce;
  slippage_pct?: number;           // max slippage % for Market orders (default: 1)
}

export interface HLOrderResult {
  order_id: string;
  status: 'pending' | 'filled' | 'partially_filled' | 'failed';
  token_symbol: string;
  side: HLSide;
  filled_size: number;
  avg_fill_price: number;
  fee_usd: number;
  timestamp: string;
}

export interface HLClosePositionRequest {
  token_symbol: string;
  side: HLSide;
  size_usd?: number;               // partial close if specified, full close if omitted
}

export interface HLSetLeverageRequest {
  token_symbol: string;
  leverage: number;
  leverage_type: 'Cross' | 'Isolated';
}

export interface HLPosition {
  token_symbol: string;
  side: HLSide;
  size_usd: number;
  leverage: number;
  entry_price: number;
  mark_price: number;
  liquidation_price: number;
  unrealized_pnl_usd: number;
  margin_used: number;
}

export interface HLAccountSummary {
  total_equity_usd: number;
  available_margin_usd: number;
  used_margin_usd: number;
  total_unrealized_pnl_usd: number;
  positions: HLPosition[];
}

export class OnchainOsHyperliquidClient {
  private http: AxiosInstance;
  private apiKey: string;
  private apiSecret: string;
  readonly dryRun: boolean;

  constructor(
    apiKey: string,
    apiSecret: string,
    baseUrl = 'https://web3.okx.com/api/v1',
    dryRun = true
  ) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.dryRun = dryRun;

    this.http = axios.create({
      baseURL: baseUrl,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30_000,
    });

    this.http.interceptors.request.use(config => {
      const timestamp = new Date().toISOString();
      const method = (config.method || 'GET').toUpperCase();
      const path = config.url || '';
      const body = config.data ? JSON.stringify(config.data) : '';
      const prehash = `${timestamp}${method}${path}${body}`;

      const signature = crypto
        .createHmac('sha256', this.apiSecret)
        .update(prehash)
        .digest('base64');

      config.headers['OK-ACCESS-KEY'] = this.apiKey;
      config.headers['OK-ACCESS-SIGN'] = signature;
      config.headers['OK-ACCESS-TIMESTAMP'] = timestamp;

      return config;
    });

    this.http.interceptors.response.use(
      res => res,
      err => {
        const status = err.response?.status;
        const msg = err.response?.data?.msg || err.message;
        logger.error(`OnchainOS HL error (${status}): ${msg}`);
        throw err;
      }
    );
  }

  /** Place a new perp position on Hyperliquid via OnchainOS */
  async placeOrder(req: HLPlaceOrderRequest): Promise<HLOrderResult> {
    if (this.dryRun) {
      logger.warn('[DRY RUN] Would place order:');
      logger.warn(`  ${req.side} ${req.token_symbol} ${req.size_usd}USD @ ${req.leverage}x`);
      return this.mockOrderResult(req);
    }

    logger.trade(`Placing ${req.side} ${req.token_symbol} $${req.size_usd} @ ${req.leverage}x...`);
    const { data } = await this.http.post('/hyperliquid/order', {
      token_symbol: req.token_symbol,
      side: req.side.toLowerCase(),
      order_type: req.order_type.toLowerCase(),
      size_usd: req.size_usd,
      leverage: req.leverage,
      limit_price: req.limit_price,
      reduce_only: req.reduce_only ?? false,
      time_in_force: req.time_in_force ?? 'GoodTilCanceled',
      slippage_pct: req.slippage_pct ?? 1,
    });

    return data.data;
  }

  /** Close an existing position (full or partial) */
  async closePosition(req: HLClosePositionRequest): Promise<HLOrderResult> {
    if (this.dryRun) {
      logger.warn(`[DRY RUN] Would close ${req.side} ${req.token_symbol}`);
      return this.mockOrderResult({
        token_symbol: req.token_symbol,
        side: req.side,
        order_type: 'Market',
        size_usd: req.size_usd ?? 0,
        leverage: 1,
        reduce_only: true,
      });
    }

    logger.trade(`Closing ${req.side} ${req.token_symbol}...`);
    const { data } = await this.http.post('/hyperliquid/close', {
      token_symbol: req.token_symbol,
      side: req.side.toLowerCase(),
      size_usd: req.size_usd,
    });

    return data.data;
  }

  /** Set leverage for a token before placing order */
  async setLeverage(req: HLSetLeverageRequest): Promise<void> {
    if (this.dryRun) {
      logger.warn(`[DRY RUN] Would set ${req.token_symbol} leverage to ${req.leverage}x (${req.leverage_type})`);
      return;
    }

    await this.http.post('/hyperliquid/leverage', {
      token_symbol: req.token_symbol,
      leverage: req.leverage,
      leverage_type: req.leverage_type.toLowerCase(),
    });
  }

  /** Get current account summary and all open positions */
  async getAccountSummary(): Promise<HLAccountSummary> {
    if (this.dryRun) {
      return {
        total_equity_usd: 0,
        available_margin_usd: 0,
        used_margin_usd: 0,
        total_unrealized_pnl_usd: 0,
        positions: [],
      };
    }

    const { data } = await this.http.get('/hyperliquid/account');
    return data.data;
  }

  private mockOrderResult(req: HLPlaceOrderRequest): HLOrderResult {
    return {
      order_id: `dry-run-${Date.now()}`,
      status: 'filled',
      token_symbol: req.token_symbol,
      side: req.side,
      filled_size: req.size_usd / (req.limit_price ?? 1),
      avg_fill_price: req.limit_price ?? 0,
      fee_usd: req.size_usd * 0.0005,
      timestamp: new Date().toISOString(),
    };
  }
}
