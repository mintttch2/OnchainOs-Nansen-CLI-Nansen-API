import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';
import {
  SmartMoneyPerpTradesRequest,
  SmartMoneyPerpTradesResponse,
  PerpScreenerRequest,
  PerpScreenerResponse,
  AddressPerpPositionsRequest,
  AddressPerpPositionsResponse,
  TokenPerpPositionsRequest,
  TokenPerpPositionsResponse,
  PerpSentiment,
  CopyTradeSetup,
  PerpSide,
} from './hyperliquid-types';
import { formatUsd } from '../utils/formatting';

/**
 * NansenHyperliquidClient — Dedicated client for all Nansen Hyperliquid endpoints
 * Uses token SYMBOLS (BTC, ETH) not addresses — Hyperliquid-specific
 */
export class NansenHyperliquidClient {
  private http: AxiosInstance;

  constructor(apiKey: string, baseUrl = 'https://api.nansen.ai') {
    this.http = axios.create({
      baseURL: baseUrl,
      headers: {
        'Content-Type': 'application/json',
        apiKey,
      },
      timeout: 30_000,
    });

    this.http.interceptors.response.use(
      res => res,
      err => {
        const status = err.response?.status;
        const msg = err.response?.data?.message || err.message;
        logger.error(`Nansen HL API error (${status}): ${msg}`);
        throw err;
      }
    );
  }

  // ─── Raw Endpoints ──────────────────────────────────────────────────────────

  /** Real-time smart money perp trades on Hyperliquid */
  async getSmartMoneyPerpTrades(
    req: SmartMoneyPerpTradesRequest
  ): Promise<SmartMoneyPerpTradesResponse> {
    logger.debug('Fetching smart money perp trades...');
    const { data } = await this.http.post('/api/v1/smart-money/perp-trades', req);
    return data;
  }

  /** Screen all perp tokens — general or smart-money filtered */
  async screenPerps(req: PerpScreenerRequest): Promise<PerpScreenerResponse> {
    logger.debug('Screening perp tokens...');
    const { data } = await this.http.post('/api/v1/perp-screener', req);
    return data;
  }

  /** Get all open perp positions for a specific wallet address */
  async getAddressPerpPositions(
    req: AddressPerpPositionsRequest
  ): Promise<AddressPerpPositionsResponse> {
    logger.debug(`Fetching perp positions for ${req.address}...`);
    const { data } = await this.http.post('/api/v1/profiler/perp-positions', req);
    return data;
  }

  /** Get all open positions for a specific token — see who's long/short */
  async getTokenPerpPositions(
    req: TokenPerpPositionsRequest
  ): Promise<TokenPerpPositionsResponse> {
    logger.debug(`Fetching perp positions for ${req.token_symbol}...`);
    const { data } = await this.http.post('/api/v1/tgm/perp-positions', req);
    return data;
  }

  // ─── Smart Money Sentiment ──────────────────────────────────────────────────

  /**
   * Compute smart money sentiment for a token.
   * Combines screener (aggregate flows) + token positions (current positioning).
   * Returns a directional signal with confidence.
   */
  async getSmartMoneySentiment(tokenSymbol: string): Promise<PerpSentiment> {
    logger.info(`Computing smart money sentiment for ${tokenSymbol}...`);

    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [screenerRes, positionsRes] = await Promise.all([
      this.screenPerps({
        date: {
          from: yesterday.toISOString(),
          to: now.toISOString(),
        },
        filters: {
          only_smart_money: true,
          token_symbol: tokenSymbol,
        },
      }),
      this.getTokenPerpPositions({
        token_symbol: tokenSymbol,
        label_type: 'smart_money',
        order_by: [{ field: 'position_value_usd', direction: 'DESC' }],
        pagination: { page: 1, per_page: 100 },
      }),
    ]);

    const screener = screenerRes.data[0];
    const positions = positionsRes.data;

    // Aggregate current positioning
    let longUsd = 0, shortUsd = 0, longCount = 0, shortCount = 0;
    for (const p of positions) {
      if (p.side === 'Long') { longUsd += p.position_value_usd; longCount++; }
      else { shortUsd += Math.abs(p.position_value_usd); shortCount++; }
    }

    // Use screener data if available, fallback to position aggregation
    const smLongUsd = screener?.current_smart_money_position_longs_usd ?? longUsd;
    const smShortUsd = screener?.current_smart_money_position_shorts_usd ?? shortUsd;
    const smLongCount = screener?.smart_money_longs_count ?? longCount;
    const smShortCount = screener?.smart_money_shorts_count ?? shortCount;
    const netFlow24h = screener?.net_position_change ?? (smLongUsd - smShortUsd);
    const smBuyVol = screener?.smart_money_buy_volume ?? 0;
    const smSellVol = screener?.smart_money_sell_volume ?? 0;
    const totalVol = smBuyVol + smSellVol;
    const buyPressurePct = totalVol > 0 ? (smBuyVol / totalVol) * 100 : 50;

    const totalPositioned = smLongUsd + smShortUsd;
    const longShortRatio = smShortUsd > 0 ? smLongUsd / smShortUsd : smLongUsd > 0 ? 99 : 1;
    const netPositionUsd = smLongUsd - smShortUsd;

    // Signal scoring
    const longBias = totalPositioned > 0 ? smLongUsd / totalPositioned : 0.5;
    const flowBias = totalVol > 0 ? smBuyVol / totalVol : 0.5;
    const compositeScore = longBias * 0.6 + flowBias * 0.4;

    let signal: PerpSentiment['signal'];
    let confidence: number;

    if (compositeScore >= 0.72) { signal = 'strong_long'; confidence = compositeScore; }
    else if (compositeScore >= 0.58) { signal = 'lean_long'; confidence = compositeScore; }
    else if (compositeScore <= 0.28) { signal = 'strong_short'; confidence = 1 - compositeScore; }
    else if (compositeScore <= 0.42) { signal = 'lean_short'; confidence = 1 - compositeScore; }
    else { signal = 'neutral'; confidence = 0.5; }

    const reasoning = [
      `Smart money: ${smLongCount} longs (${formatUsd(smLongUsd)}) vs ${smShortCount} shorts (${formatUsd(smShortUsd)})`,
      `L/S ratio: ${longShortRatio.toFixed(2)}x | Net position: ${formatUsd(netPositionUsd)}`,
      `24h flow: buy ${buyPressurePct.toFixed(0)}% / sell ${(100 - buyPressurePct).toFixed(0)}%`,
      `Net 24h change: ${netFlow24h >= 0 ? '+' : ''}${formatUsd(netFlow24h)}`,
    ].join(' | ');

    return {
      token_symbol: tokenSymbol,
      timestamp: now,
      smart_money_long_usd: smLongUsd,
      smart_money_short_usd: smShortUsd,
      long_short_ratio: longShortRatio,
      net_position_usd: netPositionUsd,
      smart_money_longs_count: smLongCount,
      smart_money_shorts_count: smShortCount,
      net_flow_24h_usd: netFlow24h,
      buy_pressure_pct: buyPressurePct,
      signal,
      confidence,
      reasoning,
    };
  }

  // ─── Copy Trade ─────────────────────────────────────────────────────────────

  /**
   * Find the best smart money trader to copy on a specific token.
   * Picks the trader with largest position + positive PnL.
   */
  async getCopyTradeSetup(
    tokenSymbol: string,
    side?: PerpSide
  ): Promise<CopyTradeSetup | null> {
    logger.info(`Finding copy trade setup for ${tokenSymbol}...`);

    const req: TokenPerpPositionsRequest = {
      token_symbol: tokenSymbol,
      label_type: 'smart_money',
      filters: side ? { side } : undefined,
      order_by: [{ field: 'upnl_usd', direction: 'DESC' }],
      pagination: { page: 1, per_page: 20 },
    };

    const res = await this.getTokenPerpPositions(req);

    // Pick best candidate: profitable, reasonable leverage, not near liquidation
    const candidate = res.data.find(p => {
      const distToLiq = Math.abs(p.mark_price - p.liquidation_price) / p.mark_price;
      return p.upnl_usd > 0 && p.leverage <= 20 && distToLiq > 0.05;
    }) ?? res.data[0];

    if (!candidate) return null;

    const distToLiqPct = ((Math.abs(candidate.mark_price - candidate.liquidation_price) / candidate.mark_price) * 100).toFixed(1);

    return {
      source_trader: candidate.address,
      source_label: candidate.address_label || 'Smart Money Wallet',
      token_symbol: tokenSymbol,
      side: candidate.side,
      suggested_leverage: Math.min(candidate.leverage, 10), // cap at 10x for safety
      entry_context: `Original entry: $${candidate.entry_price.toFixed(2)} | Current: $${candidate.mark_price.toFixed(2)}`,
      trader_unrealized_pnl_usd: candidate.upnl_usd,
      trader_position_value_usd: candidate.position_value_usd,
      liquidation_price: candidate.liquidation_price,
      risk_note: `${distToLiqPct}% away from liquidation at $${candidate.liquidation_price.toFixed(2)}. Use lower leverage than source (suggested: ${Math.min(candidate.leverage, 10)}x).`,
    };
  }

  // ─── Screener Helpers ───────────────────────────────────────────────────────

  /** Find top tokens by smart money activity in the last N hours */
  async getTopSmartMoneyPerps(
    hours = 24,
    limit = 20
  ): Promise<PerpScreenerResponse> {
    const now = new Date();
    const from = new Date(now.getTime() - hours * 60 * 60 * 1000);

    return this.screenPerps({
      date: { from: from.toISOString(), to: now.toISOString() },
      filters: {
        only_smart_money: true,
        smart_money_volume: { min: 10_000 },
      },
      order_by: [{ field: 'net_position_change', direction: 'DESC' }],
      pagination: { page: 1, per_page: limit },
    });
  }

  /** Get latest smart money open positions (new trades only) */
  async getSmartMoneyNewPositions(limit = 20): Promise<SmartMoneyPerpTradesResponse> {
    return this.getSmartMoneyPerpTrades({
      only_new_positions: true,
      filters: {
        include_smart_money_labels: ['Fund', 'Smart HL Perps Trader', 'Smart Trader'],
        value_usd: { min: 5_000 },
      },
      order_by: [{ field: 'value_usd', direction: 'DESC' }],
      pagination: { page: 1, per_page: limit },
    });
  }
}
