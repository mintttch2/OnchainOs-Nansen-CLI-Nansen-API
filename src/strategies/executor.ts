import { OnchainOsClient } from '../onchainos/client';
import { SwapQuote } from '../onchainos/types';
import { logger } from '../utils/logger';
import { formatUsd } from '../utils/formatting';
import { AlphaSignal } from './types';
import { AppConfig } from '../config';

export interface ExecutionResult {
  signal: AlphaSignal;
  quote: SwapQuote | null;
  executed: boolean;
  txHash?: string;
  error?: string;
}

export class TradeExecutor {
  private onchainOs: OnchainOsClient;
  private config: AppConfig;

  constructor(onchainOs: OnchainOsClient, config: AppConfig) {
    this.onchainOs = onchainOs;
    this.config = config;
  }

  async getQuoteForSignal(signal: AlphaSignal): Promise<SwapQuote | null> {
    try {
      const nativeToken = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
      const quote = await this.onchainOs.getSwapQuote({
        chainId: signal.token.chain,
        fromTokenAddress: nativeToken,
        toTokenAddress: signal.token.address,
        amount: String(this.config.agent.maxTradeSizeUsd),
        slippage: '1.0',
        userWalletAddress: this.config.onchainOs.walletAddress,
      });

      logger.info(
        `Quote for ${signal.token.symbol}: ` +
        `${quote.fromAmount} ${quote.fromToken.symbol} -> ${quote.toAmount} ${quote.toToken.symbol}`
      );

      return quote;
    } catch (error) {
      logger.error(`Failed to get quote for ${signal.token.symbol}: ${error}`);
      return null;
    }
  }

  async executeSignal(signal: AlphaSignal): Promise<ExecutionResult> {
    logger.trade(`Processing signal: ${signal.token.symbol} (${signal.type})`);

    // Safety checks
    if (signal.action !== 'buy') {
      return { signal, quote: null, executed: false, error: 'Signal action is not buy' };
    }

    if (signal.confidence < this.config.agent.smartMoneyMinConfidence) {
      return {
        signal,
        quote: null,
        executed: false,
        error: `Confidence ${signal.confidence.toFixed(2)} below threshold ${this.config.agent.smartMoneyMinConfidence}`,
      };
    }

    // Get quote
    const quote = await this.getQuoteForSignal(signal);
    if (!quote) {
      return { signal, quote: null, executed: false, error: 'Failed to get swap quote' };
    }

    // Only execute in auto-trade mode
    if (this.config.agent.mode !== 'auto-trade') {
      logger.info(
        `[DRY RUN] Would swap ${formatUsd(this.config.agent.maxTradeSizeUsd)} ` +
        `for ${signal.token.symbol} on ${signal.token.chain}`
      );
      return { signal, quote, executed: false, error: 'Agent mode is not auto-trade' };
    }

    // Execute swap
    try {
      const result = await this.onchainOs.executeSwap({
        chainId: signal.token.chain,
        fromTokenAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
        toTokenAddress: signal.token.address,
        amount: String(this.config.agent.maxTradeSizeUsd),
        slippage: '1.0',
        userWalletAddress: this.config.onchainOs.walletAddress,
      });

      logger.trade(
        `Swap executed: ${result.txHash} (${result.status})`
      );

      return { signal, quote, executed: true, txHash: result.txHash };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Swap execution failed: ${msg}`);
      return { signal, quote, executed: false, error: msg };
    }
  }

  async processSignals(signals: AlphaSignal[]): Promise<ExecutionResult[]> {
    const buySignals = signals.filter(s => s.action === 'buy');
    logger.info(`Processing ${buySignals.length} buy signals out of ${signals.length} total`);

    const results: ExecutionResult[] = [];
    for (const signal of buySignals) {
      const result = await this.executeSignal(signal);
      results.push(result);
    }

    return results;
  }
}
