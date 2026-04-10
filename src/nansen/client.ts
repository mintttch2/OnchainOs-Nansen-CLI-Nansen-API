import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';
import {
  SmartMoneyNetflowRequest,
  SmartMoneyNetflowResponse,
  SmartMoneyHoldingsRequest,
  SmartMoneyHoldingsResponse,
  SmartMoneyDexTradesRequest,
  SmartMoneyDexTradesResponse,
  TokenScreenerRequest,
  TokenScreenerResponse,
  NansenAgentRequest,
  NansenAgentResponse,
} from './types';

export class NansenClient {
  private http: AxiosInstance;

  constructor(apiKey: string, baseUrl = 'https://api.nansen.ai') {
    this.http = axios.create({
      baseURL: baseUrl,
      headers: {
        'Content-Type': 'application/json',
        apiKey: apiKey,
      },
      timeout: 30_000,
    });

    this.http.interceptors.response.use(
      response => response,
      error => {
        const status = error.response?.status;
        const msg = error.response?.data?.message || error.message;
        logger.error(`Nansen API error (${status}): ${msg}`);
        throw error;
      }
    );
  }

  // ─── Smart Money ───

  async getSmartMoneyNetflows(
    request: SmartMoneyNetflowRequest
  ): Promise<SmartMoneyNetflowResponse> {
    logger.debug('Fetching smart money netflows...');
    const { data } = await this.http.post('/api/v1/smart-money/netflow', request);
    logger.debug(`Got ${data.data?.length || 0} netflow results`);
    return data;
  }

  async getSmartMoneyHoldings(
    request: SmartMoneyHoldingsRequest
  ): Promise<SmartMoneyHoldingsResponse> {
    logger.debug('Fetching smart money holdings...');
    const { data } = await this.http.post('/api/v1/smart-money/holdings', request);
    logger.debug(`Got ${data.data?.length || 0} holdings results`);
    return data;
  }

  async getSmartMoneyDexTrades(
    request: SmartMoneyDexTradesRequest
  ): Promise<SmartMoneyDexTradesResponse> {
    logger.debug('Fetching smart money DEX trades...');
    const { data } = await this.http.post('/api/v1/smart-money/dex-trades', request);
    logger.debug(`Got ${data.data?.length || 0} DEX trade results`);
    return data;
  }

  // ─── Token Screener ───

  async screenTokens(
    request: TokenScreenerRequest
  ): Promise<TokenScreenerResponse> {
    logger.debug('Running token screener...');
    const { data } = await this.http.post('/api/v1/token-screener', request);
    logger.debug(`Got ${data.data?.length || 0} token screener results`);
    return data;
  }

  // ─── Nansen Agent ───

  async askAgent(
    request: NansenAgentRequest,
    tier: 'fast' | 'expert' = 'fast'
  ): Promise<NansenAgentResponse> {
    logger.debug(`Asking Nansen ${tier} agent...`);
    const { data } = await this.http.post(`/api/v1/agent/${tier}`, request);
    return data;
  }

  // ─── Convenience Methods ───

  async getTopSmartMoneyBuys(
    chains: string[] | 'all' = 'all',
    limit = 20
  ): Promise<SmartMoneyNetflowResponse> {
    return this.getSmartMoneyNetflows({
      chains,
      filters: {
        include_stablecoins: false,
        include_native_tokens: false,
      },
      order_by: [{ field: 'net_flow_24h_usd', direction: 'DESC' }],
      pagination: { page: 1, per_page: limit },
    });
  }

  async getSmartMoneyFundActivity(
    chains: string[] | 'all' = 'all',
    limit = 20
  ): Promise<SmartMoneyNetflowResponse> {
    return this.getSmartMoneyNetflows({
      chains,
      filters: {
        include_smart_money_labels: ['Fund'],
        include_stablecoins: false,
      },
      order_by: [{ field: 'net_flow_7d_usd', direction: 'DESC' }],
      pagination: { page: 1, per_page: limit },
    });
  }

  async getHotTokens(
    chains: string[],
    timeframe: '1h' | '24h' | '7d' = '24h',
    limit = 20
  ): Promise<TokenScreenerResponse> {
    return this.screenTokens({
      chains,
      timeframe,
      order_by: [{ field: 'volume_usd', direction: 'DESC' }],
      pagination: { page: 1, per_page: limit },
    });
  }

  async getTopSmartMoneyHoldings(
    chains: string[] | 'all' = 'all',
    limit = 20
  ): Promise<SmartMoneyHoldingsResponse> {
    return this.getSmartMoneyHoldings({
      chains,
      order_by: [{ field: 'value_usd', direction: 'DESC' }],
      pagination: { page: 1, per_page: limit },
    });
  }
}
