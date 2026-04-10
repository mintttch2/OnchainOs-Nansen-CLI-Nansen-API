import ora from 'ora';
import chalk from 'chalk';
import Table from 'cli-table3';
import { loadConfig } from '../../config';
import { NansenClient } from '../../nansen/client';
import { AlphaDetector } from '../../strategies/alpha-detector';
import { formatUsd, formatPercent } from '../../utils/formatting';
import { AlphaSignal } from '../../strategies/types';

interface ScanOptions {
  chain?: string[];
  limit: string;
  minConfidence: string;
  json?: boolean;
}

export async function scanCommand(options: ScanOptions): Promise<void> {
  const config = loadConfig();
  const nansen = new NansenClient(config.nansen.apiKey, config.nansen.baseUrl);
  const detector = new AlphaDetector(nansen, {
    minConfidence: parseFloat(options.minConfidence),
  });

  const spinner = ora('Scanning for smart money alpha signals...').start();

  try {
    const chains = options.chain || 'all';
    const signals = await detector.detectSignals(chains as string[] | 'all');
    const limited = signals.slice(0, parseInt(options.limit));

    spinner.succeed(`Found ${signals.length} signals`);

    if (options.json) {
      console.log(JSON.stringify(limited, null, 2));
      return;
    }

    if (limited.length === 0) {
      console.log(chalk.yellow('\nNo signals match your criteria. Try lowering --min-confidence.'));
      return;
    }

    printSignalTable(limited);
    printSignalDetails(limited.slice(0, 5));
  } catch (error) {
    spinner.fail('Scan failed');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}

function printSignalTable(signals: AlphaSignal[]): void {
  const table = new Table({
    head: [
      chalk.white('Token'),
      chalk.white('Chain'),
      chalk.white('Type'),
      chalk.white('Strength'),
      chalk.white('Confidence'),
      chalk.white('Net Flow 24h'),
      chalk.white('Mkt Cap'),
      chalk.white('Action'),
    ],
    colWidths: [12, 12, 25, 12, 12, 14, 14, 10],
  });

  for (const s of signals) {
    const strengthColor =
      s.strength === 'very_strong' ? chalk.green.bold :
      s.strength === 'strong' ? chalk.green :
      s.strength === 'moderate' ? chalk.yellow :
      chalk.gray;

    const actionColor = s.action === 'buy' ? chalk.green.bold : chalk.gray;

    table.push([
      chalk.cyan(s.token.symbol),
      s.token.chain,
      s.type.replace(/_/g, ' '),
      strengthColor(s.strength),
      `${(s.confidence * 100).toFixed(0)}%`,
      s.metrics.netFlow24h ? formatUsd(s.metrics.netFlow24h) : '-',
      s.metrics.marketCap ? formatUsd(s.metrics.marketCap) : '-',
      actionColor(s.action.toUpperCase()),
    ]);
  }

  console.log('\n' + table.toString());
}

function printSignalDetails(signals: AlphaSignal[]): void {
  console.log(chalk.white.bold('\n--- Top Signal Details ---\n'));

  for (const s of signals) {
    const icon =
      s.strength === 'very_strong' ? '>>>' :
      s.strength === 'strong' ? '>>' : '>';

    console.log(chalk.magenta.bold(`${icon} ${s.token.symbol} (${s.token.chain})`));
    console.log(chalk.gray(`   Type: ${s.type.replace(/_/g, ' ')}`));
    console.log(chalk.gray(`   ${s.reasoning}`));

    if (s.metrics.traderCount) {
      console.log(chalk.gray(`   Traders: ${s.metrics.traderCount}`));
    }
    if (s.metrics.priceChange24h) {
      console.log(chalk.gray(`   Price 24h: ${formatPercent(s.metrics.priceChange24h)}`));
    }

    console.log('');
  }
}
