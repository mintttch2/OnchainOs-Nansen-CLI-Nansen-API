#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { scanCommand } from './commands/hl-scan';
import { sentimentCommand } from './commands/hl-sentiment';
import { positionsCommand } from './commands/hl-positions';
import { newPositionsCommand } from './commands/hl-new-positions';
import { copyCommand } from './commands/hl-copy';
import { tradeCommand } from './commands/hl-trade';
import { autoCommand } from './commands/hl-auto';
import { copybotCommand } from './commands/hl-copybot';
import { leaderboardCommand } from './commands/hl-leaderboard';

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

program
  .command('auto')
  .description('Start autonomous smart money auto-trader (scans, scores, trades, manages positions)')
  .option('-i, --interval <minutes>', 'Scan interval in minutes', '5')
  .option('-r, --risk <level>', 'Risk level: low, medium, high', 'medium')
  .option('--max-trade <usd>', 'Max trade size in USD', '500')
  .option('--max-positions <n>', 'Max simultaneous positions', '4')
  .option('--max-exposure <usd>', 'Max total exposure in USD', '2000')
  .option('--stop-loss <pct>', 'Stop loss percentage', '5')
  .option('--take-profit <pct>', 'Take profit percentage', '15')
  .option('--trailing-stop <pct>', 'Trailing stop from peak PnL', '3')
  .option('--lookback <hours>', 'Nansen screener lookback hours', '4')
  .option('--tokens <n>', 'Number of tokens to scan per cycle', '12')
  .option('--live', 'Execute real trades (default: dry run)')
  .action(autoCommand);

program
  .command('stats')
  .description('Show auto-trader performance stats from trade log')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    const { PortfolioTracker } = await import('../strategies/portfolio-tracker');
    const tracker = new PortfolioTracker();
    if (options.json) {
      console.log(JSON.stringify({ stats: tracker.getStats(), trades: tracker.getAllTrades() }, null, 2));
    } else {
      const stats = tracker.getStats();
      if (stats.totalTrades === 0) {
        console.log(chalk.yellow('No trades recorded yet. Run `hypernansen auto` to start.'));
        return;
      }
      console.log(chalk.cyan.bold('\nHyperNansen Auto-Trader Performance'));
      console.log('─'.repeat(50));
      console.log(tracker.getSummary());

      // Show last 10 trades
      const recent = tracker.getAllTrades().filter(t => t.status === 'closed').slice(-10).reverse();
      if (recent.length > 0) {
        const Table = (await import('cli-table3')).default;
        const { formatUsd } = await import('../utils/formatting');
        const table = new Table({
          head: ['Token', 'Side', 'PnL', 'PnL%', 'Hold', 'Exit Reason'].map(h => chalk.gray(h)),
        });
        for (const t of recent) {
          const pnlColor = t.pnlUsd >= 0 ? chalk.green : chalk.red;
          const sideColor = t.side === 'Long' ? chalk.green : chalk.red;
          const holdMin = t.exitTime
            ? Math.round((new Date(t.exitTime).getTime() - new Date(t.entryTime).getTime()) / 60_000)
            : 0;
          table.push([
            chalk.cyan(t.token),
            sideColor(t.side),
            pnlColor(formatUsd(t.pnlUsd)),
            pnlColor(`${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}%`),
            `${holdMin}m`,
            t.exitReason || '-',
          ]);
        }
        console.log('\n' + chalk.white.bold('Recent Trades (last 10):'));
        console.log(table.toString());
      }
    }
  });

program
  .command('leaderboard')
  .description('Rank top smart money traders by PnL, win rate, and consistency')
  .option('-t, --timeframe <period>', 'Timeframe: 24h, 7d, 30d', '7d')
  .option('-l, --limit <n>', 'Number of traders to show', '15')
  .option('--json', 'Output as JSON')
  .action(leaderboardCommand);

program
  .command('copybot')
  .description('Smart copy-trading bot — follows top traders + validates with market indicators')
  .option('-i, --interval <minutes>', 'Scan interval in minutes', '3')
  .option('-t, --timeframe <period>', 'Trader ranking timeframe: 24h, 7d, 30d', '7d')
  .option('-r, --risk <level>', 'Risk level: low, medium, high', 'medium')
  .option('--max-trade <usd>', 'Max trade size per copy', '500')
  .option('--watch-count <n>', 'Number of top traders to watch', '10')
  .option('--min-score <n>', 'Min trader score to follow (0-100)', '50')
  .option('--min-market <score>', 'Min market confirmation score (-1 to 1)', '0.1')
  .option('--live', 'Execute real trades (default: dry run)')
  .action(copybotCommand);

program.parse();
