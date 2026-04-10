import { NansenClient } from '../nansen/client';
import { OnchainOsClient } from '../onchainos/client';
import { AlphaDetector } from '../strategies/alpha-detector';
import { TradeExecutor } from '../strategies/executor';
import { SkillDefinition, SkillResponse } from '../onchainos/types';
import { AppConfig } from '../config';
import { formatUsd } from '../utils/formatting';

export function createNansenSkills(
  nansen: NansenClient,
  onchainOs: OnchainOsClient,
  config: AppConfig
): SkillDefinition[] {
  const detector = new AlphaDetector(nansen, {
    minConfidence: config.agent.smartMoneyMinConfidence,
  });
  const executor = new TradeExecutor(onchainOs, config);

  return [
    // Skill 1: Smart Money Alpha Scanner
    {
      name: 'nansen_alpha_scan',
      description:
        'Scans Nansen smart money data to detect alpha signals — tokens being accumulated by funds, whales, and smart traders. Returns ranked signals with confidence scores.',
      parameters: [
        {
          name: 'chains',
          type: 'array',
          description: 'Blockchain networks to scan (e.g., ["ethereum", "solana"]). Use "all" for all chains.',
          required: false,
          default: 'all',
        },
        {
          name: 'min_confidence',
          type: 'number',
          description: 'Minimum confidence threshold (0-1). Higher = fewer but stronger signals.',
          required: false,
          default: 0.7,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Maximum number of signals to return.',
          required: false,
          default: 10,
        },
      ],
      execute: async (params): Promise<SkillResponse> => {
        try {
          const chains = (params.chains as string[] | string) || 'all';
          const minConf = (params.min_confidence as number) || 0.7;
          const limit = (params.limit as number) || 10;

          const d = new AlphaDetector(nansen, { minConfidence: minConf });
          const signals = await d.detectSignals(chains as string[] | 'all');
          const top = signals.slice(0, limit);

          const summary = top.map(s => ({
            token: s.token.symbol,
            chain: s.token.chain,
            signal_type: s.type,
            confidence: `${(s.confidence * 100).toFixed(0)}%`,
            strength: s.strength,
            action: s.action,
            reasoning: s.reasoning,
            net_flow_24h: s.metrics.netFlow24h ? formatUsd(s.metrics.netFlow24h) : null,
            market_cap: s.metrics.marketCap ? formatUsd(s.metrics.marketCap) : null,
          }));

          return {
            success: true,
            data: summary,
            message: `Found ${signals.length} signals. Showing top ${top.length}.`,
          };
        } catch (error) {
          return {
            success: false,
            data: null,
            message: `Alpha scan failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },

    // Skill 2: Smart Money Holdings
    {
      name: 'nansen_smart_money_holdings',
      description:
        'Shows what tokens smart money wallets (funds, whales, top traders) are currently holding, ranked by total USD value.',
      parameters: [
        {
          name: 'chains',
          type: 'array',
          description: 'Chains to filter (default: all)',
          required: false,
          default: 'all',
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Number of results',
          required: false,
          default: 20,
        },
      ],
      execute: async (params): Promise<SkillResponse> => {
        try {
          const chains = (params.chains as string[] | string) || 'all';
          const limit = (params.limit as number) || 20;
          const result = await nansen.getTopSmartMoneyHoldings(chains as string[] | 'all', limit);

          return {
            success: true,
            data: result.data.map(h => ({
              token: h.token_symbol,
              chain: h.chain,
              value_usd: formatUsd(h.value_usd),
              change_24h: `${h.balance_24h_percent_change.toFixed(1)}%`,
              holders: h.holders_count,
              market_cap: formatUsd(h.market_cap_usd),
              sectors: h.token_sectors,
            })),
            message: `Top ${result.data.length} smart money holdings.`,
          };
        } catch (error) {
          return {
            success: false,
            data: null,
            message: `Failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },

    // Skill 3: Smart Money Fund Tracker
    {
      name: 'nansen_fund_tracker',
      description:
        'Tracks what crypto funds are buying and selling. Shows fund-specific inflows/outflows to identify institutional conviction.',
      parameters: [
        {
          name: 'chains',
          type: 'array',
          description: 'Chains to filter',
          required: false,
          default: 'all',
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Number of results',
          required: false,
          default: 20,
        },
      ],
      execute: async (params): Promise<SkillResponse> => {
        try {
          const chains = (params.chains as string[] | string) || 'all';
          const limit = (params.limit as number) || 20;
          const result = await nansen.getSmartMoneyFundActivity(chains as string[] | 'all', limit);

          return {
            success: true,
            data: result.data.map(f => ({
              token: f.token_symbol,
              chain: f.chain,
              net_flow_7d: formatUsd(f.net_flow_7d_usd),
              net_flow_24h: formatUsd(f.net_flow_24h_usd),
              traders: f.trader_count,
              market_cap: formatUsd(f.market_cap_usd),
            })),
            message: `Fund activity: ${result.data.length} tokens with fund flows.`,
          };
        } catch (error) {
          return {
            success: false,
            data: null,
            message: `Failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },

    // Skill 4: Signal-to-Trade
    {
      name: 'nansen_signal_trade',
      description:
        'Detects the strongest smart money alpha signal and gets a swap quote via OKX OnchainOS DEX aggregator. Can auto-execute in auto-trade mode.',
      parameters: [
        {
          name: 'chain',
          type: 'string',
          description: 'Target chain for trading (default: xlayer)',
          required: false,
          default: 'xlayer',
        },
        {
          name: 'amount_usd',
          type: 'number',
          description: 'Trade amount in USD',
          required: false,
          default: 100,
        },
        {
          name: 'auto_execute',
          type: 'boolean',
          description: 'Automatically execute the trade (requires auto-trade mode)',
          required: false,
          default: false,
        },
      ],
      execute: async (params): Promise<SkillResponse> => {
        try {
          const chain = (params.chain as string) || config.agent.defaultChain;
          const signals = await detector.detectSignals([chain]);
          const buySignals = signals.filter(s => s.action === 'buy');

          if (buySignals.length === 0) {
            return {
              success: true,
              data: { signals: signals.length, buy_signals: 0 },
              message: 'No strong buy signals detected right now. Try again later or lower confidence threshold.',
            };
          }

          const topSignal = buySignals[0];
          const quote = await executor.getQuoteForSignal(topSignal);

          const result: Record<string, unknown> = {
            signal: {
              token: topSignal.token.symbol,
              chain: topSignal.token.chain,
              confidence: `${(topSignal.confidence * 100).toFixed(0)}%`,
              type: topSignal.type,
              reasoning: topSignal.reasoning,
            },
            quote: quote
              ? {
                  from: `${quote.fromAmount} ${quote.fromToken.symbol}`,
                  to: `${quote.toAmount} ${quote.toToken.symbol}`,
                  price_impact: quote.priceImpact,
                }
              : null,
          };

          if (params.auto_execute && config.agent.mode === 'auto-trade') {
            const execResult = await executor.executeSignal(topSignal);
            result.execution = {
              executed: execResult.executed,
              tx_hash: execResult.txHash || null,
              error: execResult.error || null,
            };
          }

          return {
            success: true,
            data: result,
            message: `Top signal: ${topSignal.token.symbol} (${(topSignal.confidence * 100).toFixed(0)}% confidence)`,
          };
        } catch (error) {
          return {
            success: false,
            data: null,
            message: `Signal-to-trade failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },

    // Skill 5: Ask Nansen
    {
      name: 'nansen_ask',
      description:
        'Ask the Nansen AI agent a natural language question about on-chain data, smart money movements, token analysis, or market trends.',
      parameters: [
        {
          name: 'question',
          type: 'string',
          description: 'Natural language question about on-chain data',
          required: true,
        },
        {
          name: 'tier',
          type: 'string',
          description: 'Agent tier: "fast" (200 credits) or "expert" (750 credits)',
          required: false,
          default: 'fast',
        },
      ],
      execute: async (params): Promise<SkillResponse> => {
        try {
          const question = params.question as string;
          const tier = (params.tier as 'fast' | 'expert') || 'fast';
          const response = await nansen.askAgent({ prompt: question }, tier);

          return {
            success: true,
            data: {
              answer: response.answer,
              confidence: `${(response.confidence * 100).toFixed(0)}%`,
              sources: response.sources,
            },
            message: response.answer,
          };
        } catch (error) {
          return {
            success: false,
            data: null,
            message: `Nansen agent failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
  ];
}
