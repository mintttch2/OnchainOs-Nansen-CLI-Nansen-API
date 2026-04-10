import ora from 'ora';
import chalk from 'chalk';
import Table from 'cli-table3';
import { loadConfig } from '../../config';
import { NansenHyperliquidClient } from '../../nansen/hyperliquid-client';
import { formatUsd } from '../../utils/formatting';

interface NewPositionsOptions { token?: string; side?: string; limit: string; json?: boolean; }

export async function newPositionsCommand(options: NewPositionsOptions): Promise<void> {
  const config = loadConfig();
  const hl = new NansenHyperliquidClient(config.nansen.apiKey, config.nansen.baseUrl);
  const spinner = ora('Loading latest smart money position opens...').start();

  try {
    const result = await hl.getSmartMoneyPerpTrades({
      only_new_positions: true,
      filters: {
        include_smart_money_labels: ['Fund', 'Smart HL Perps Trader', 'Smart Trader'],
        token_symbol: options.token?.toUpperCase(),
        side: options.side as 'Long' | 'Short' | undefined,
        value_usd: { min: 5_000 },
      },
      order_by: [{ field: 'value_usd', direction: 'DESC' }],
      pagination: { page: 1, per_page: parseInt(options.limit) },
    });

    spinner.succeed(`${result.data.length} new smart money positions`);

    if (options.json) { console.log(JSON.stringify(result.data, null, 2)); return; }

    const table = new Table({
      head: ['Trader', 'Token', 'Side', 'Action', 'Size', 'Price', 'Type', 'Time'].map(h => chalk.white(h)),
    });

    for (const t of result.data) {
      const sideColor = t.side === 'Long' ? chalk.green : chalk.red;
      const isOpen = t.action.includes('Open');

      table.push([
        t.trader_address_label ? chalk.cyan(t.trader_address_label.slice(0, 20)) : chalk.gray(t.trader_address.slice(0, 12) + '...'),
        chalk.white.bold(t.token_symbol),
        sideColor(t.side),
        isOpen ? chalk.white(t.action) : chalk.gray(t.action),
        formatUsd(t.value_usd),
        `$${t.price_usd.toFixed(2)}`,
        t.type,
        new Date(t.block_timestamp).toISOString().slice(11, 16) + ' UTC',
      ]);
    }

    console.log('\n' + table.toString());
  } catch (err) {
    spinner.fail('Failed');
    console.error(chalk.red(String(err)));
    process.exit(1);
  }
}
