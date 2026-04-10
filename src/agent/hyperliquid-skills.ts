import { NansenHyperliquidClient } from '../nansen/hyperliquid-client';
import { OnchainOsHyperliquidClient } from '../onchainos/hyperliquid-client';
import { SkillDefinition, SkillResponse } from '../onchainos/types';
import { formatUsd } from '../utils/formatting';
import { AppConfig } from '../config';

/**
 * HyperNansen Skills — Nansen Smart Money Intelligence × OKX OnchainOS Hyperliquid Plugin
 *
 * These skills power an autonomous agent that:
 * 1. Reads smart money perp positioning from Nansen
 * 2. Computes directional sentiment signals
 * 3. Finds top traders to copy
 * 4. Executes perp trades via OnchainOS Hyperliquid plugin
 */
export function createHyperliquidSkills(
  nansenHL: NansenHyperliquidClient,
  onchainHL: OnchainOsHyperliquidClient,
  config: AppConfig
): SkillDefinition[] {
  return [

    // ── Skill 1: Smart Money Perp Scanner ─────────────────────────────────────
    {
      name: 'hl_smart_money_scan',
      description:
        'Scans Hyperliquid perp markets to find tokens where smart money (funds, top traders) are most active. ' +
        'Returns tokens ranked by smart money net position change — the highest = smart money going long, ' +
        'the most negative = smart money going short.',
      parameters: [
        {
          name: 'hours',
          type: 'number',
          description: 'Lookback window in hours (default: 24)',
          required: false,
          default: 24,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Number of results to return (default: 15)',
          required: false,
          default: 15,
        },
        {
          name: 'min_smart_money_volume',
          type: 'number',
          description: 'Minimum smart money volume in USD (default: 10000)',
          required: false,
          default: 10000,
        },
      ],
      execute: async (params): Promise<SkillResponse> => {
        try {
          const hours = (params.hours as number) || 24;
          const limit = (params.limit as number) || 15;

          const result = await nansenHL.getTopSmartMoneyPerps(hours, limit);

          const formatted = result.data.map(t => ({
            token: t.token_symbol,
            net_position_change: t.net_position_change !== undefined
              ? formatUsd(t.net_position_change) : 'N/A',
            smart_money_longs: t.smart_money_longs_count ?? 0,
            smart_money_shorts: t.smart_money_shorts_count ?? 0,
            sm_long_usd: t.current_smart_money_position_longs_usd !== undefined
              ? formatUsd(t.current_smart_money_position_longs_usd) : 'N/A',
            sm_short_usd: t.current_smart_money_position_shorts_usd !== undefined
              ? formatUsd(t.current_smart_money_position_shorts_usd) : 'N/A',
            smart_money_volume: t.smart_money_volume !== undefined
              ? formatUsd(t.smart_money_volume) : 'N/A',
            funding: t.funding !== undefined ? `${(t.funding * 100).toFixed(4)}%` : 'N/A',
            open_interest: t.open_interest !== undefined ? formatUsd(t.open_interest) : 'N/A',
            // derived: positive = SM leaning long, negative = leaning short
            bias: (() => {
              const l = t.current_smart_money_position_longs_usd ?? 0;
              const s = t.current_smart_money_position_shorts_usd ?? 0;
              const total = l + s;
              if (total === 0) return 'neutral';
              const pct = (l / total * 100).toFixed(0);
              if (Number(pct) >= 65) return `LONG bias (${pct}% long)`;
              if (Number(pct) <= 35) return `SHORT bias (${pct}% long)`;
              return `Neutral (${pct}% long)`;
            })(),
          }));

          return {
            success: true,
            data: formatted,
            message: `Smart money most active on: ${formatted.slice(0, 3).map(t => t.token).join(', ')}`,
          };
        } catch (err) {
          return { success: false, data: null, message: String(err) };
        }
      },
    },

    // ── Skill 2: Token Sentiment ────────────────────────────────────────────
    {
      name: 'hl_sentiment',
      description:
        'Get smart money directional sentiment for a specific Hyperliquid perp token. ' +
        'Combines current positioning (who is long vs short) with 24h flow data to produce ' +
        'a signal: strong_long, lean_long, neutral, lean_short, or strong_short. ' +
        'Use this before taking a position to see if smart money agrees with your trade.',
      parameters: [
        {
          name: 'token',
          type: 'string',
          description: 'Token symbol (e.g. BTC, ETH, SOL, ARB)',
          required: true,
        },
      ],
      execute: async (params): Promise<SkillResponse> => {
        try {
          const token = (params.token as string).toUpperCase();
          const sentiment = await nansenHL.getSmartMoneySentiment(token);

          const signalEmoji: Record<string, string> = {
            strong_long: 'STRONG LONG',
            lean_long: 'LEAN LONG',
            neutral: 'NEUTRAL',
            lean_short: 'LEAN SHORT',
            strong_short: 'STRONG SHORT',
          };

          return {
            success: true,
            data: {
              token: sentiment.token_symbol,
              signal: signalEmoji[sentiment.signal],
              confidence: `${(sentiment.confidence * 100).toFixed(0)}%`,
              smart_money_longs: `${sentiment.smart_money_longs_count} wallets (${formatUsd(sentiment.smart_money_long_usd)})`,
              smart_money_shorts: `${sentiment.smart_money_shorts_count} wallets (${formatUsd(sentiment.smart_money_short_usd)})`,
              long_short_ratio: sentiment.long_short_ratio.toFixed(2) + 'x',
              net_position: formatUsd(sentiment.net_position_usd),
              buy_pressure_24h: `${sentiment.buy_pressure_pct.toFixed(0)}%`,
              net_flow_24h: formatUsd(sentiment.net_flow_24h_usd),
              reasoning: sentiment.reasoning,
            },
            message: `${token}: ${signalEmoji[sentiment.signal]} (${(sentiment.confidence * 100).toFixed(0)}% confidence) — ${sentiment.reasoning}`,
          };
        } catch (err) {
          return { success: false, data: null, message: String(err) };
        }
      },
    },

    // ── Skill 3: Who is Long/Short a Token ──────────────────────────────────
    {
      name: 'hl_who_is_positioned',
      description:
        'See exactly which smart money wallets are currently long or short a specific perp token on Hyperliquid. ' +
        'Shows their position size, entry price, leverage, unrealized PnL, and distance to liquidation. ' +
        'Useful for understanding conviction levels and finding liquidation clusters.',
      parameters: [
        {
          name: 'token',
          type: 'string',
          description: 'Token symbol (e.g. BTC, ETH, SOL)',
          required: true,
        },
        {
          name: 'side',
          type: 'string',
          description: 'Filter by side: "Long", "Short", or omit for both',
          required: false,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Number of positions to return (default: 15)',
          required: false,
          default: 15,
        },
      ],
      execute: async (params): Promise<SkillResponse> => {
        try {
          const token = (params.token as string).toUpperCase();
          const side = params.side as 'Long' | 'Short' | undefined;
          const limit = (params.limit as number) || 15;

          const result = await nansenHL.getTokenPerpPositions({
            token_symbol: token,
            label_type: 'smart_money',
            filters: side ? { side } : undefined,
            order_by: [{ field: 'position_value_usd', direction: 'DESC' }],
            pagination: { page: 1, per_page: limit },
          });

          const formatted = result.data.map(p => {
            const distToLiq = ((Math.abs(p.mark_price - p.liquidation_price) / p.mark_price) * 100).toFixed(1);
            return {
              trader: p.address_label || p.address.slice(0, 10) + '...',
              address: p.address,
              side: p.side,
              size: formatUsd(p.position_value_usd),
              leverage: `${p.leverage}x (${p.leverage_type})`,
              entry: `$${p.entry_price.toFixed(2)}`,
              mark: `$${p.mark_price.toFixed(2)}`,
              liq_price: `$${p.liquidation_price.toFixed(2)}`,
              dist_to_liq: `${distToLiq}%`,
              unrealized_pnl: formatUsd(p.upnl_usd),
              funding_paid: formatUsd(p.funding_usd),
            };
          });

          const longs = result.data.filter(p => p.side === 'Long');
          const shorts = result.data.filter(p => p.side === 'Short');
          const totalLong = longs.reduce((s, p) => s + p.position_value_usd, 0);
          const totalShort = shorts.reduce((s, p) => s + Math.abs(p.position_value_usd), 0);

          return {
            success: true,
            data: {
              summary: {
                total_long_positions: longs.length,
                total_short_positions: shorts.length,
                total_long_usd: formatUsd(totalLong),
                total_short_usd: formatUsd(totalShort),
              },
              positions: formatted,
            },
            message: `${token}: ${longs.length} smart money longs (${formatUsd(totalLong)}) vs ${shorts.length} shorts (${formatUsd(totalShort)})`,
          };
        } catch (err) {
          return { success: false, data: null, message: String(err) };
        }
      },
    },

    // ── Skill 4: New Smart Money Positions ──────────────────────────────────
    {
      name: 'hl_new_positions',
      description:
        'See the most recent positions that smart money wallets just opened on Hyperliquid. ' +
        'Filters for "Open Long" and "Open Short" actions only — these are new bets, not existing ones. ' +
        'Ranked by size. Use this to follow what smart money is doing right now.',
      parameters: [
        {
          name: 'token',
          type: 'string',
          description: 'Filter by specific token symbol (optional)',
          required: false,
        },
        {
          name: 'side',
          type: 'string',
          description: 'Filter by side: "Long" or "Short" (optional)',
          required: false,
        },
        {
          name: 'limit',
          type: 'number',
          description: 'Number of results (default: 20)',
          required: false,
          default: 20,
        },
      ],
      execute: async (params): Promise<SkillResponse> => {
        try {
          const token = params.token as string | undefined;
          const side = params.side as 'Long' | 'Short' | undefined;
          const limit = (params.limit as number) || 20;

          const result = await nansenHL.getSmartMoneyPerpTrades({
            only_new_positions: true,
            filters: {
              include_smart_money_labels: ['Fund', 'Smart HL Perps Trader', 'Smart Trader'],
              token_symbol: token,
              side,
              value_usd: { min: 5_000 },
            },
            order_by: [{ field: 'value_usd', direction: 'DESC' }],
            pagination: { page: 1, per_page: limit },
          });

          const formatted = result.data.map(t => ({
            trader: t.trader_address_label || t.trader_address.slice(0, 10) + '...',
            token: t.token_symbol,
            side: t.side,
            action: t.action,
            size: formatUsd(t.value_usd),
            price: `$${t.price_usd.toFixed(2)}`,
            type: t.type,
            time: new Date(t.block_timestamp).toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
            tx: t.transaction_hash.slice(0, 12) + '...',
          }));

          const longCount = formatted.filter(t => t.side === 'Long').length;
          const shortCount = formatted.filter(t => t.side === 'Short').length;

          return {
            success: true,
            data: formatted,
            message: `${formatted.length} new smart money positions: ${longCount} longs, ${shortCount} shorts`,
          };
        } catch (err) {
          return { success: false, data: null, message: String(err) };
        }
      },
    },

    // ── Skill 5: Copy Trade Setup ───────────────────────────────────────────
    {
      name: 'hl_copy_setup',
      description:
        'Find the best smart money trader to copy on a specific token and get their full position setup. ' +
        'Returns the source trader, direction (long/short), suggested leverage, and risk assessment. ' +
        'Picks the trader with the highest unrealized PnL and safe distance from liquidation.',
      parameters: [
        {
          name: 'token',
          type: 'string',
          description: 'Token symbol to copy trade on (e.g. BTC, ETH)',
          required: true,
        },
        {
          name: 'preferred_side',
          type: 'string',
          description: 'Preferred side: "Long" or "Short" (optional, will find best regardless)',
          required: false,
        },
      ],
      execute: async (params): Promise<SkillResponse> => {
        try {
          const token = (params.token as string).toUpperCase();
          const side = params.preferred_side as 'Long' | 'Short' | undefined;

          const setup = await nansenHL.getCopyTradeSetup(token, side);

          if (!setup) {
            return {
              success: true,
              data: null,
              message: `No suitable smart money copy trade found for ${token} right now.`,
            };
          }

          return {
            success: true,
            data: {
              source_trader: setup.source_label,
              source_address: setup.source_trader,
              token: setup.token_symbol,
              direction: setup.side,
              suggested_leverage: `${setup.suggested_leverage}x`,
              entry_context: setup.entry_context,
              trader_pnl: formatUsd(setup.trader_unrealized_pnl_usd),
              trader_position_size: formatUsd(setup.trader_position_value_usd),
              liquidation_price: `$${setup.liquidation_price.toFixed(2)}`,
              risk_note: setup.risk_note,
            },
            message: `Copy ${setup.side} ${token} following ${setup.source_label} (${formatUsd(setup.trader_unrealized_pnl_usd)} PnL). ${setup.risk_note}`,
          };
        } catch (err) {
          return { success: false, data: null, message: String(err) };
        }
      },
    },

    // ── Skill 6: Execute Perp Trade via OnchainOS ──────────────────────────
    {
      name: 'hl_execute_trade',
      description:
        'Execute a perpetual trade on Hyperliquid via OKX OnchainOS. ' +
        'Opens a long or short position with specified leverage and size. ' +
        'In dry-run mode (default): simulates the trade and shows what would happen. ' +
        'In live mode: actually submits the order via OnchainOS Hyperliquid plugin.',
      parameters: [
        {
          name: 'token',
          type: 'string',
          description: 'Token symbol (e.g. BTC, ETH, SOL)',
          required: true,
        },
        {
          name: 'side',
          type: 'string',
          description: '"Long" or "Short"',
          required: true,
        },
        {
          name: 'size_usd',
          type: 'number',
          description: 'Position size in USD',
          required: true,
        },
        {
          name: 'leverage',
          type: 'number',
          description: 'Leverage multiplier (1-20, default: 5)',
          required: false,
          default: 5,
        },
        {
          name: 'order_type',
          type: 'string',
          description: '"Market" (default) or "Limit"',
          required: false,
          default: 'Market',
        },
        {
          name: 'limit_price',
          type: 'number',
          description: 'Required if order_type is Limit',
          required: false,
        },
      ],
      execute: async (params): Promise<SkillResponse> => {
        try {
          const leverage = Math.min((params.leverage as number) || 5, 20);
          const orderType = (params.order_type as 'Market' | 'Limit') || 'Market';

          // Safety check: max position size from config
          const sizeUsd = Math.min(
            params.size_usd as number,
            config.agent.maxTradeSizeUsd
          );

          const result = await onchainHL.placeOrder({
            token_symbol: (params.token as string).toUpperCase(),
            side: params.side as 'Long' | 'Short',
            order_type: orderType,
            size_usd: sizeUsd,
            leverage,
            limit_price: params.limit_price as number | undefined,
            slippage_pct: 1,
          });

          const dryRunNote = onchainHL.dryRun
            ? ' [DRY RUN — set AGENT_MODE=live to execute real trades]'
            : '';

          return {
            success: true,
            data: {
              order_id: result.order_id,
              status: result.status,
              token: result.token_symbol,
              side: result.side,
              size: formatUsd(sizeUsd),
              leverage: `${leverage}x`,
              avg_fill_price: result.avg_fill_price > 0 ? `$${result.avg_fill_price.toFixed(2)}` : 'pending',
              fee: formatUsd(result.fee_usd),
              timestamp: result.timestamp,
              dry_run: onchainHL.dryRun,
            },
            message: `${result.status.toUpperCase()}: ${result.side} ${result.token_symbol} ${formatUsd(sizeUsd)} @ ${leverage}x${dryRunNote}`,
          };
        } catch (err) {
          return { success: false, data: null, message: String(err) };
        }
      },
    },

  ];
}
