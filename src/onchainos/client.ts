import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import { logger } from '../utils/logger';
import {
  WalletInfo,
  TokenBalance,
  SwapQuoteRequest,
  SwapQuote,
  SwapExecuteRequest,
  SwapResult,
  MarketTokenPrice,
  CHAIN_IDS,
} from './types';

export class OnchainOsClient {
  private http: AxiosInstance;
  private apiKey: string;
  private apiSecret: string;

  constructor(apiKey: string, apiSecret: string, baseUrl = 'https://web3.okx.com/api/v1') {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;

    this.http = axios.create({
      baseURL: baseUrl,
      headers: {
        'Content-Type': 'application/json',
      },
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
      config.headers['OK-ACCESS-PASSPHRASE'] = '';

      return config;
    });

    this.http.interceptors.response.use(
      response => response,
      error => {
        const status = error.response?.status;
        const msg = error.response?.data?.msg || error.message;
        logger.error(`OnchainOS API error (${status}): ${msg}`);
        throw error;
      }
    );
  }

  // ─── Wallet ───

  async getWalletInfo(address: string, chain = 'xlayer'): Promise<WalletInfo> {
    logger.debug(`Getting wallet info for ${address} on ${chain}`);
    const chainId = CHAIN_IDS[chain] || chain;
    const { data } = await this.http.get('/wallet/balance', {
      params: { address, chainId },
    });
    return data.data;
  }

  async getTokenBalances(address: string, chain = 'xlayer'): Promise<TokenBalance[]> {
    logger.debug(`Getting token balances for ${address} on ${chain}`);
    const chainId = CHAIN_IDS[chain] || chain;
    const { data } = await this.http.get('/wallet/token-balances', {
      params: { address, chainId },
    });
    return data.data || [];
  }

  // ─── Trade (DEX Aggregation) ───

  async getSwapQuote(request: SwapQuoteRequest): Promise<SwapQuote> {
    logger.debug(
      `Getting swap quote: ${request.fromTokenAddress} -> ${request.toTokenAddress}`
    );
    const { data } = await this.http.get('/trade/quote', {
      params: {
        chainId: CHAIN_IDS[request.chainId] || request.chainId,
        fromTokenAddress: request.fromTokenAddress,
        toTokenAddress: request.toTokenAddress,
        amount: request.amount,
        slippage: request.slippage || '0.5',
        userWalletAddress: request.userWalletAddress,
      },
    });
    return data.data;
  }

  async executeSwap(request: SwapExecuteRequest): Promise<SwapResult> {
    logger.debug('Executing swap via OnchainOS DEX aggregator...');
    const { data } = await this.http.post('/trade/swap', {
      chainId: CHAIN_IDS[request.chainId] || request.chainId,
      fromTokenAddress: request.fromTokenAddress,
      toTokenAddress: request.toTokenAddress,
      amount: request.amount,
      slippage: request.slippage,
      userWalletAddress: request.userWalletAddress,
    });
    return data.data;
  }

  // ─── Market Data ───

  async getTokenPrice(
    tokenAddress: string,
    chain = 'xlayer'
  ): Promise<MarketTokenPrice> {
    logger.debug(`Getting token price for ${tokenAddress} on ${chain}`);
    const chainId = CHAIN_IDS[chain] || chain;
    const { data } = await this.http.get('/market/token-price', {
      params: { tokenAddress, chainId },
    });
    return data.data;
  }

  async getTokenPrices(
    tokenAddresses: string[],
    chain = 'xlayer'
  ): Promise<MarketTokenPrice[]> {
    logger.debug(`Getting ${tokenAddresses.length} token prices on ${chain}`);
    const chainId = CHAIN_IDS[chain] || chain;
    const { data } = await this.http.post('/market/token-prices', {
      tokenAddresses,
      chainId,
    });
    return data.data || [];
  }

  // ─── Utility ───

  resolveChainId(chain: string): string {
    return CHAIN_IDS[chain.toLowerCase()] || chain;
  }
}
