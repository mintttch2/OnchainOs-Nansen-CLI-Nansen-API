import ora from 'ora';
import chalk from 'chalk';
import Table from 'cli-table3';
import { loadConfig } from '../../config';
import { NansenClient } from '../../nansen/client';
import { formatUsd, formatPercent } from '../../utils/formatting';

interface HoldingsOptions {
  chain?: string[];
  limit: string;
  json?: boolean;
}

export async function holdingsCommand(options: HoldingsOptions): Promise<void> {
  const config = loadConfig();
  const nansen = new NansenClient(config.nansen.apiKey, config.nansen.baseUrl);

  const spinner = ora('Fetching smart money holdings...').start();

  try {
    const chains = options.chain || 'all';
    const result = await nansen.getTopSmartMoneyHoldings(
      chains as string[] | 'all',
      parseInt(options.limit)
    );

    spinner.succeed(`Loaded ${result.data.length} holdings`);

    if (options.json) {
      console.log(JSON.stringify(result.data, null, 2));
      return;
    }

    const table = new Table({
      head: [
        chalk.white('#'),
        chalk.white('Token'),
        chalk.white('Chain'),
        chalk.white('Value (USD)'),
        chalk.white('24h Change'),
        chalk.white('Holders'),
        chalk.white('Market Cap'),
        chalk.white('Sectors'),
      ],
    });

    result.data.forEach((h, i) => {
      const changeColor = h.balance_24h_percent_change >= 0 ? chalk.green : chalk.red;

      table.push([
        String(i + 1),
        chalk.cyan(h.token_symbol),
        h.chain,
        formatUsd(h.value_usd),
        changeColor(formatPercent(h.balance_24h_percent_change)),
        String(h.holders_count),
        formatUsd(h.market_cap_usd),
        h.token_sectors?.join(', ') || '-',
      ]);
    });

    console.log('\n' + table.toString());
  } catch (error) {
    spinner.fail('Failed to fetch holdings');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}
