// ─── Wallet Types ───

export interface WalletInfo {
  address: string;
  chain: string;
  balance: string;
  balanceUsd: number;
}

export interface TokenBalance {
  tokenAddress: string;
  tokenSymbol: string;
  balance: string;
  balanceUsd: number;
  chain: string;
}

// ─── Trade Types ───

export interface SwapQuoteRequest {
  chainId: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;
  slippage?: string;
  userWalletAddress: string;
}

export interface SwapQuote {
  fromToken: TokenInfo;
  toToken: TokenInfo;
  fromAmount: string;
  toAmount: string;
  estimatedGas: string;
  priceImpact: string;
  route: SwapRoute[];
}

export interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
  name: string;
}

export interface SwapRoute {
  dex: string;
  percentage: number;
  path: string[];
}

export interface SwapExecuteRequest {
  chainId: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;
  slippage: string;
  userWalletAddress: string;
}

export interface SwapResult {
  txHash: string;
  status: 'pending' | 'confirmed' | 'failed';
  fromAmount: string;
  toAmount: string;
  gasUsed: string;
}

// ─── Market Types ───

export interface MarketTokenPrice {
  tokenAddress: string;
  tokenSymbol: string;
  chain: string;
  priceUsd: number;
  priceChange24h: number;
  volume24h: number;
  marketCap: number;
  lastUpdated: string;
}

export interface MarketChainData {
  chain: string;
  tvl: number;
  volume24h: number;
  transactions24h: number;
  activeAddresses24h: number;
}

// ─── OnchainOS Skill Types ───

export interface SkillDefinition {
  name: string;
  description: string;
  parameters: SkillParameter[];
  execute: (params: Record<string, unknown>) => Promise<SkillResponse>;
}

export interface SkillParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array';
  description: string;
  required: boolean;
  default?: unknown;
}

export interface SkillResponse {
  success: boolean;
  data: unknown;
  message: string;
}

// ─── Common ───

export type SupportedChain =
  | 'ethereum'
  | 'polygon'
  | 'arbitrum'
  | 'optimism'
  | 'bsc'
  | 'avalanche'
  | 'solana'
  | 'xlayer'
  | 'base';

export const CHAIN_IDS: Record<string, string> = {
  ethereum: '1',
  polygon: '137',
  arbitrum: '42161',
  optimism: '10',
  bsc: '56',
  avalanche: '43114',
  xlayer: '196',
  base: '8453',
};

export const NATIVE_TOKEN_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
