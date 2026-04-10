import ora from 'ora';
import chalk from 'chalk';
import Table from 'cli-table3';
import { loadConfig } from '../../config';
import { NansenHyperliquidClient } from '../../nansen/hyperliquid-client';
import { formatUsd } from '../../utils/formatting';

interface ScanOptions { hours: string; limit: string; json?: boolean; }

export async function scanCommand(options: ScanOptions): Promise<void> {
  const config = loadConfig();
  const hl = new NansenHyperliquidClient(config.nansen.apiKey, config.nansen.baseUrl);
  const spinner = ora(`Scanning Hyperliquid smart money activity (${options.hours}h)...`).start();

  try {
    const result = await hl.getTopSmartMoneyPerps(parseInt(options.hours), parseInt(options.limit));
    spinner.succeed(`Found ${result.data.length} active perp tokens`);

    if (options.json) { console.log(JSON.stringify(result.data, null, 2)); return; }
    if (result.data.length === 0) { console.log(chalk.yellow('\nNo smart money activity found.')); return; }

    const table = new Table({
      head: ['Token', 'SM Net Change', 'Longs', 'Shorts', 'SM Long $', 'SM Short $', 'Bias', 'OI', 'Funding'].map(h => chalk.white(h)),
    });

    for (const t of result.data) {
      const longUsd = t.current_smart_money_position_longs_usd ?? 0;
      const shortUsd = t.current_smart_money_position_shorts_usd ?? 0;
      const total = longUsd + shortUsd;
      const longPct = total > 0 ? (longUsd / total * 100) : 50;
      const net = t.net_position_change ?? 0;
      const biasColor = longPct >= 60 ? chalk.green : longPct <= 40 ? chalk.red : chalk.yellow;
      const netColor = net >= 0 ? chalk.green : chalk.red;

      table.push([
        chalk.cyan.bold(t.token_symbol),
        netColor(formatUsd(net)),
        String(t.smart_money_longs_count ?? 0),
        String(t.smart_money_shorts_count ?? 0),
        chalk.green(formatUsd(longUsd)),
        chalk.red(formatUsd(shortUsd)),
        biasColor(`${longPct.toFixed(0)}% L`),
        t.open_interest ? formatUsd(t.open_interest) : '-',
        t.funding ? `${(t.funding * 100).toFixed(3)}%` : '-',
      ]);
    }

    console.log('\n' + table.toString());
    console.log(chalk.gray(`\nSM Net Change: positive = smart money net buying | negative = net selling`));
  } catch (err) {
    spinner.fail('Scan failed');
    console.error(chalk.red(String(err)));
    process.exit(1);
  }
}
