import ora from 'ora';
import chalk from 'chalk';
import Table from 'cli-table3';
import { loadConfig } from '../../config';
import { NansenHyperliquidClient } from '../../nansen/hyperliquid-client';
import { TraderProfiler, Timeframe } from '../../strategies/trader-profiler';
import { formatUsd } from '../../utils/formatting';

interface LeaderboardOptions {
  timeframe: string;
  limit: string;
  json?: boolean;
}

export async function leaderboardCommand(options: LeaderboardOptions): Promise<void> {
  const config = loadConfig();
  const nansenHL = new NansenHyperliquidClient(config.nansen.apiKey, config.nansen.baseUrl);
  const profiler = new TraderProfiler(nansenHL);
  const tf = (options.timeframe as Timeframe) || '7d';
  const limit = parseInt(options.limit);

  const spinner = ora(`Building smart money leaderboard (${tf})...`).start();

  try {
    const leaderboard = await profiler.getLeaderboard(tf, limit);
    spinner.succeed(`${leaderboard.length} traders ranked`);

    if (options.json) {
      console.log(JSON.stringify(leaderboard.map(t => ({
        ...t,
        openPositions: t.openPositions.map(p => ({
          ...p,
        })),
      })), null, 2));
      return;
    }

    if (leaderboard.length === 0) {
      console.log(chalk.yellow('\nNo smart money traders found.'));
      return;
    }

    console.log(chalk.cyan.bold(`\nSmart Money Trader Leaderboard — ${tf}`));
    console.log(chalk.gray('Ranked by composite score (PnL + win rate + consistency + risk management)\n'));

    const table = new Table({
      head: ['#', 'Tier', 'Trader', 'Score', 'PnL', 'Win Rate', 'Trades', 'Open Pos', 'Open PnL', 'PF'].map(h => chalk.white(h)),
    });

    for (let i = 0; i < leaderboard.length; i++) {
      const t = leaderboard[i];
      const tierColor = t.tier === 'S' ? chalk.green.bold : t.tier === 'A' ? chalk.cyan.bold : t.tier === 'B' ? chalk.yellow : chalk.gray;
      const pnlColor = t.totalPnlUsd >= 0 ? chalk.green : chalk.red;
      const openPnlColor = t.totalOpenPnl >= 0 ? chalk.green : chalk.red;
      const wrColor = t.winRate >= 60 ? chalk.green : t.winRate >= 40 ? chalk.yellow : chalk.red;

      table.push([
        chalk.gray(String(i + 1)),
        tierColor(t.tier),
        chalk.white(t.label.slice(0, 22)),
        chalk.white.bold(String(t.score)),
        pnlColor(formatUsd(t.totalPnlUsd)),
        wrColor(`${t.winRate.toFixed(0)}%`),
        String(t.totalTrades),
        String(t.openPositions.length),
        openPnlColor(formatUsd(t.totalOpenPnl)),
        t.profitFactor === Infinity ? chalk.green('Inf') : t.profitFactor >= 2 ? chalk.green(t.profitFactor.toFixed(2)) : t.profitFactor.toFixed(2),
      ]);
    }

    console.log(table.toString());

    // Show top trader details
    const top = leaderboard[0];
    if (top && top.openPositions.length > 0) {
      console.log(chalk.cyan.bold(`\n#1 ${top.label} — Current Positions:`));
      const posTable = new Table({
        head: ['Token', 'Side', 'Size', 'Leverage', 'Entry', 'Mark', 'Liq', 'Dist%', 'uPnL'].map(h => chalk.gray(h)),
      });

      for (const p of top.openPositions.slice(0, 8)) {
        const sideColor = p.side === 'Long' ? chalk.green : chalk.red;
        const pnlColor = p.upnlUsd >= 0 ? chalk.green : chalk.red;
        const distColor = p.distToLiqPct < 10 ? chalk.red : p.distToLiqPct < 20 ? chalk.yellow : chalk.gray;

        posTable.push([
          chalk.cyan(p.token),
          sideColor(p.side),
          formatUsd(p.sizeUsd),
          `${p.leverage}x`,
          `$${p.entryPrice.toFixed(2)}`,
          `$${p.markPrice.toFixed(2)}`,
          `$${p.liqPrice.toFixed(2)}`,
          distColor(`${p.distToLiqPct.toFixed(1)}%`),
          pnlColor(formatUsd(p.upnlUsd)),
        ]);
      }

      console.log(posTable.toString());
      console.log(chalk.gray(`\nTo copy-trade the best traders: hypernansen copybot --timeframe ${tf}`));
    }
  } catch (err) {
    spinner.fail('Leaderboard failed');
    console.error(chalk.red(String(err)));
    process.exit(1);
  }
}
