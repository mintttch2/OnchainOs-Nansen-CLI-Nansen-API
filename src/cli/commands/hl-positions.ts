import ora from 'ora';
import chalk from 'chalk';
import Table from 'cli-table3';
import { loadConfig } from '../../config';
import { NansenHyperliquidClient } from '../../nansen/hyperliquid-client';
import { formatUsd } from '../../utils/formatting';

interface PositionsOptions { side?: string; limit: string; json?: boolean; }

export async function positionsCommand(token: string, options: PositionsOptions): Promise<void> {
  const config = loadConfig();
  const hl = new NansenHyperliquidClient(config.nansen.apiKey, config.nansen.baseUrl);
  const sym = token.toUpperCase();
  const sideFilter = options.side as 'Long' | 'Short' | undefined;
  const spinner = ora(`Loading smart money positions on ${sym}...`).start();

  try {
    const result = await hl.getTokenPerpPositions({
      token_symbol: sym,
      label_type: 'smart_money',
      filters: sideFilter ? { side: sideFilter } : undefined,
      order_by: [{ field: 'position_value_usd', direction: 'DESC' }],
      pagination: { page: 1, per_page: parseInt(options.limit) },
    });

    spinner.succeed(`${result.data.length} smart money positions on ${sym}`);

    if (options.json) { console.log(JSON.stringify(result.data, null, 2)); return; }

    const longs = result.data.filter(p => p.side === 'Long');
    const shorts = result.data.filter(p => p.side === 'Short');
    const totalL = longs.reduce((s, p) => s + p.position_value_usd, 0);
    const totalS = shorts.reduce((s, p) => s + Math.abs(p.position_value_usd), 0);

    console.log(`\n${chalk.cyan.bold(sym)} — Smart Money Positions`);
    console.log(`  ${chalk.green(`Longs: ${longs.length} wallets (${formatUsd(totalL)})`)}  |  ${chalk.red(`Shorts: ${shorts.length} wallets (${formatUsd(totalS)})`)}\n`);

    const table = new Table({
      head: ['Trader', 'Side', 'Size', 'Leverage', 'Entry', 'Mark', 'Liq.', 'Dist%', 'uPnL', 'Funding'].map(h => chalk.white(h)),
    });

    for (const p of result.data) {
      const distPct = ((Math.abs(p.mark_price - p.liquidation_price) / p.mark_price) * 100).toFixed(1);
      const pnlColor = p.upnl_usd >= 0 ? chalk.green : chalk.red;
      const sideColor = p.side === 'Long' ? chalk.green : chalk.red;
      const distColor = Number(distPct) < 10 ? chalk.red : Number(distPct) < 20 ? chalk.yellow : chalk.gray;

      table.push([
        p.address_label ? chalk.cyan(p.address_label.slice(0, 18)) : chalk.gray(p.address.slice(0, 12) + '...'),
        sideColor(p.side),
        formatUsd(p.position_value_usd),
        `${p.leverage}x`,
        `$${p.entry_price.toFixed(2)}`,
        `$${p.mark_price.toFixed(2)}`,
        `$${p.liquidation_price.toFixed(2)}`,
        distColor(`${distPct}%`),
        pnlColor(formatUsd(p.upnl_usd)),
        p.funding_usd !== 0 ? formatUsd(p.funding_usd) : '-',
      ]);
    }

    console.log(table.toString());
  } catch (err) {
    spinner.fail('Failed');
    console.error(chalk.red(String(err)));
    process.exit(1);
  }
}
