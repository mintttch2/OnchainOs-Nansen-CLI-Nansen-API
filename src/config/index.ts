import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export interface AppConfig {
  nansen: {
    apiKey: string;
    baseUrl: string;
  };
  onchainOs: {
    apiKey: string;
    apiSecret: string;
    baseUrl: string;
    walletAddress: string;
  };
  agent: {
    mode: 'monitor' | 'alert' | 'auto-trade';
    defaultChain: string;
    riskLevel: 'low' | 'medium' | 'high';
    maxTradeSizeUsd: number;
    smartMoneyMinConfidence: number;
  };
  xlayer: {
    rpcUrl: string;
    chainId: number;
  };
}

export function loadConfig(): AppConfig {
  return {
    nansen: {
      apiKey: process.env.NANSEN_API_KEY || '',
      baseUrl: process.env.NANSEN_API_BASE_URL || 'https://api.nansen.ai',
    },
    onchainOs: {
      apiKey: process.env.ONCHAINOS_API_KEY || '',
      apiSecret: process.env.ONCHAINOS_API_SECRET || '',
      baseUrl: process.env.ONCHAINOS_BASE_URL || 'https://web3.okx.com/api/v1',
      walletAddress: process.env.ONCHAINOS_WALLET_ADDRESS || '',
    },
    agent: {
      mode: (process.env.AGENT_MODE as AppConfig['agent']['mode']) || 'monitor',
      defaultChain: process.env.DEFAULT_CHAIN || 'xlayer',
      riskLevel: (process.env.RISK_LEVEL as AppConfig['agent']['riskLevel']) || 'medium',
      maxTradeSizeUsd: Number(process.env.MAX_TRADE_SIZE_USD) || 100,
      smartMoneyMinConfidence: Number(process.env.SMART_MONEY_MIN_CONFIDENCE) || 0.7,
    },
    xlayer: {
      rpcUrl: process.env.XLAYER_RPC_URL || 'https://rpc.xlayer.tech',
      chainId: Number(process.env.XLAYER_CHAIN_ID) || 196,
    },
  };
}

export function validateConfig(config: AppConfig): string[] {
  const errors: string[] = [];
  if (!config.nansen.apiKey) errors.push('NANSEN_API_KEY is required');
  if (!config.onchainOs.apiKey) errors.push('ONCHAINOS_API_KEY is required');
  return errors;
}
