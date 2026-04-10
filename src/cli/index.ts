#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { scanCommand } from './commands/hl-scan';
import { sentimentCommand } from './commands/hl-sentiment';
import { positionsCommand } from './commands/hl-positions';
import { newPositionsCommand } from './commands/hl-new-positions';
import { copyCommand } from './commands/hl-copy';
import { tradeCommand } from './commands/hl-trade';

const program = new Command();

console.log(chalk.cyan.bold('\nHyperNansen — Hyperliquid Smart Money Intelligence'));
console.log(chalk.gray('Nansen Smart Money Data  ×  OKX OnchainOS Hyperliquid Plugin\n'));

program
  .name('hypernansen')
  .version('2.0.0')
  .description('Hyperliquid smart money intelligence powered by Nansen + OKX OnchainOS');

program
  .command('scan')
  .description('Find tokens where smart money is most active on Hyperliquid perps')
  .option('-h, --hours <number>', 'Lookback window in hours', '24')
  .option('-l, --limit <number>', 'Number of results', '15')
  .option('--json', 'Output as JSON')
  .action(scanCommand);

program
  .command('sentiment <token>')
  .description('Smart money long/short sentiment for a token (BTC, ETH, SOL...)')
  .option('--json', 'Output as JSON')
  .action(sentimentCommand);

program
  .command('positions <token>')
  .description('See which smart money wallets are long/short a specific perp')
  .option('-s, --side <side>', 'Filter: Long or Short')
  .option('-l, --limit <number>', 'Number of results', '15')
  .option('--json', 'Output as JSON')
  .action(positionsCommand);

program
  .command('new')
  .description('Show latest smart money position opens on Hyperliquid')
  .option('-t, --token <symbol>', 'Filter by token')
  .option('-s, --side <side>', 'Filter: Long or Short')
  .option('-l, --limit <number>', 'Number of results', '20')
  .option('--json', 'Output as JSON')
  .action(newPositionsCommand);

program
  .command('copy <token>')
  .description('Find the best smart money trader to copy on a token')
  .option('-s, --side <side>', 'Preferred side: Long or Short')
  .action(copyCommand);

program
  .command('trade')
  .description('Execute a Hyperliquid perp trade via OKX OnchainOS')
  .requiredOption('-t, --token <symbol>', 'Token symbol')
  .requiredOption('-s, --side <side>', 'Long or Short')
  .requiredOption('-z, --size <usd>', 'Position size in USD')
  .option('-l, --leverage <x>', 'Leverage (1-20x)', '5')
  .option('--limit-price <price>', 'Limit price (omit = Market order)')
  .option('--live', 'Submit real trade (default: dry run simulation)')
  .action(tradeCommand);

program.parse();
