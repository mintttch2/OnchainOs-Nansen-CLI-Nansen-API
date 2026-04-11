import chalk from 'chalk';
import inquirer from 'inquirer';
import Table from 'cli-table3';
import { loadConfig } from '../../config';
import { NansenHyperliquidClient } from '../../nansen/hyperliquid-client';
import { OnchainOsHyperliquidClient } from '../../onchainos/hyperliquid-client';
import { SmartMoneyCopyEngine, CopyCycleResult } from '../../strategies/copy-engine';
import { RiskLevel } from '../../strategies/risk-manager';
import { Timeframe } from '../../strategies/trader-profiler';
import { formatUsd } from '../../utils/formatting';

interface CopybotOptions {
  interval: string;
  timeframe: string;
  risk: string;
  maxTrade: string;
  watchCount: string;
  minScore: string;
  minMarket: string;
  live?: boolean;
}

export async function copybotCommand(options: CopybotOptions): Promise<void> {
  const config = loadConfig();
  const dryRun = !options.live;
  const risk = (options.risk as RiskLevel) || config.agent.riskLevel || 'medium';
  const timeframe = (options.timeframe as Timeframe) || '7d';

  const nansenHL = new NansenHyperliquidClient(config.nansen.apiKey, config.nansen.baseUrl);
  const onchainHL = new OnchainOsHyperliquidClient(
    config.onchainOs.apiKey,
    config.onchainOs.apiSecret,
    config.onchainOs.baseUrl,
    dryRun
  );

  const engine = new SmartMoneyCopyEngine(nansenHL, onchainHL, config, {
    scanIntervalMinutes: parseInt(options.interval),
    timeframe,
    topTradersToWatch: parseInt(options.watchCount),
    minTraderScore: parseInt(options.minScore),
    minMarketConfirmation: parseFloat(options.minMarket),
    riskLevel: risk,
    maxTradeSizeUsd: parseInt(options.maxTrade),
  });

  const riskConfig = engine.getRiskManager().config;

  // Banner
  console.log(chalk.cyan.bold('\n╔════════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan.bold('║') + chalk.white.bold('   HyperNansen Copy Bot — Smart Money Copy Trading       ') + chalk.cyan.bold('║'));
  console.log(chalk.cyan.bold('║') + chalk.gray('   Follow the best traders. Validate with market data.   ') + chalk.cyan.bold('║'));
  console.log(chalk.cyan.bold('╚════════════════════════════════════════════════════════════╝'));
  console.log('');
  console.log(`  Mode:             ${dryRun ? chalk.yellow.bold('DRY RUN (simulated)') : chalk.red.bold('LIVE COPY TRADING')}`);
  console.log(`  Risk Level:       ${chalk.white.bold(risk)}`);
  console.log(`  Scan Interval:    ${chalk.white(options.interval + ' minutes')}`);
  console.log(`  Trader Timeframe: ${chalk.white(timeframe)} PnL ranking`);
  console.log(`  Watch Top:        ${chalk.white(options.watchCount)} traders`);
  console.log(`  Min Trader Score: ${chalk.white(options.minScore + '/100')}`);
  console.log('');
  console.log(chalk.white('  Copy Rules:'));
  console.log(`    Max per trade:  ${chalk.white(formatUsd(parseInt(options.maxTrade)))}`);
  console.log(`    Max positions:  ${chalk.white(String(riskConfig.maxPositions))}`);
  console.log(`    Min market:     ${chalk.white(options.minMarket)} (indicator confirmation threshold)`);
  console.log('');
  console.log(chalk.white('  Market Indicators (checked before every copy):'));
  console.log(chalk.gray('    1. Funding Rate — Is the direction crowded?'));
  console.log(chalk.gray('    2. Open Interest — New money entering?'));
  console.log(chalk.gray('    3. SM Consensus — Do most SM wallets agree?'));
  console.log(chalk.gray('    4. Price Momentum — Is price trending our way?'));
  console.log(chalk.gray('    5. Liquidation Map — Squeeze potential or cascade risk?'));
  console.log(chalk.gray('    6. Buy/Sell Pressure — 24h SM flow direction'));
  console.log(chalk.gray('    7. Position Concentration — Broad or whale-driven?'));
  console.log('');
  console.log(chalk.white('  Exit Rules:'));
  console.log(`    Stop loss:      ${chalk.red('-' + riskConfig.stopLossPct + '%')}`);
  console.log(`    Take profit:    ${chalk.green('+' + riskConfig.takeProfitPct + '%')}`);
  console.log(`    Trailing stop:  ${chalk.yellow(riskConfig.trailingStopPct + '% from peak')}`);
  console.log(`    Source exits:   ${chalk.white('Auto-close if copied trader exits')}`);
  console.log(`    Sentiment flip: ${chalk.white('Close if SM turns against us')}`);
  console.log('');

  // Confirmation for live mode
  if (!dryRun) {
    console.log(chalk.red.bold('  WARNING: LIVE MODE — Real orders will be placed on Hyperliquid'));
    console.log('');
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: 'Start LIVE copy trading? This will use real funds.',
      default: false,
    }]);
    if (!confirm) {
      console.log(chalk.yellow('Cancelled.'));
      return;
    }
  }

  // Cycle display
  engine.onCycle((result) => {
    printCopyCycleResult(result, engine);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log(chalk.yellow('\n\nShutting down copy bot...'));
    engine.stop();
    const stats = engine.getPortfolio().getStats();
    console.log(chalk.cyan.bold('\n── Final Performance ──'));
    console.log(engine.getPortfolio().getSummary());
    process.exit(0);
  });

  await engine.start();
}

function printCopyCycleResult(result: CopyCycleResult, engine: SmartMoneyCopyEngine): void {
  const leaderboard = engine.getLeaderboard();
  const positions = engine.getActivePositions();
  const stats = engine.getPortfolio().getStats();

  console.log('');
  console.log(chalk.cyan(`── Copy Cycle #${result.cycleNumber} | ${new Date(result.timestamp).toISOString().slice(11, 19)} UTC ──`));

  // Leaderboard summary (show on first cycle and every 10th)
  if (result.cycleNumber === 1 || result.cycleNumber % 10 === 0) {
    if (leaderboard.length > 0) {
      console.log(chalk.white.bold('\n  Trader Leaderboard:'));
      const lbTable = new Table({
        head: ['Tier', 'Trader', 'Score', 'PnL', 'WR', 'Positions', 'Profit Factor'].map(h => chalk.gray(h)),
      });
      for (const t of leaderboard.slice(0, 8)) {
        const tierColor = t.tier === 'S' ? chalk.green.bold : t.tier === 'A' ? chalk.cyan : chalk.gray;
        const pnlColor = t.totalPnlUsd >= 0 ? chalk.green : chalk.red;
        lbTable.push([
          tierColor(t.tier),
          chalk.white(t.label.slice(0, 20)),
          String(t.score),
          pnlColor(formatUsd(t.totalPnlUsd)),
          `${t.winRate.toFixed(0)}%`,
          String(t.openPositions.length),
          t.profitFactor === Infinity ? 'Inf' : t.profitFactor.toFixed(2),
        ]);
      }
      console.log(lbTable.toString());
    }
  }

  // Decisions
  if (result.decisions.length > 0) {
    for (const d of result.decisions) {
      const emoji = d.decision === 'copy' ? chalk.green.bold('COPY') : chalk.gray('SKIP');
      const trader = d.move.trader.label.slice(0, 15);
      const sideColor = d.move.side === 'Long' ? chalk.green : chalk.red;
      console.log(
        `  ${emoji} ${sideColor(d.move.side)} ${chalk.cyan(d.move.token)} ` +
        `— ${trader} [${d.move.trader.tier}] | ` +
        `market: ${d.marketCondition.verdict} (${d.marketCondition.confirmsPct}%) | ` +
        `${d.reason.slice(0, 60)}`
      );
    }
  } else if (result.movesDetected === 0) {
    console.log(chalk.gray('  No new moves from watched traders'));
  }

  // Open positions
  if (positions.length > 0) {
    const posTable = new Table({
      head: ['Token', 'Side', 'Size', 'Lev', 'Entry', 'PnL %', 'Peak %', 'Hold', 'Source'].map(h => chalk.gray(h)),
    });
    for (const p of positions) {
      const sideColor = p.side === 'Long' ? chalk.green : chalk.red;
      const pnlColor = p.currentPnlPct >= 0 ? chalk.green : chalk.red;
      const holdMin = Math.round((Date.now() - p.entryTime.getTime()) / 60_000);
      const source = p.tradeId.startsWith('copy-') ? p.tradeId.split('-')[1].slice(0, 8) + '...' : '-';
      posTable.push([
        chalk.white.bold(p.token),
        sideColor(p.side),
        formatUsd(p.sizeUsd),
        `${p.leverage}x`,
        `$${p.entryPrice.toFixed(2)}`,
        pnlColor(`${p.currentPnlPct >= 0 ? '+' : ''}${p.currentPnlPct.toFixed(2)}%`),
        chalk.yellow(`${p.peakPnlPct.toFixed(2)}%`),
        `${holdMin}m`,
        chalk.gray(source),
      ]);
    }
    console.log(posTable.toString());
  }

  // Stats
  const wr = stats.closedTrades > 0 ? `${stats.winRate.toFixed(0)}%` : '-';
  console.log(chalk.gray(
    `  Watching: ${result.leaderboardSize} traders | ` +
    `Pos: ${positions.length} open | ` +
    `Trades: ${stats.closedTrades} (${stats.wins}W/${stats.losses}L, WR: ${wr}) | ` +
    `PnL: ${formatUsd(stats.totalPnlUsd)}`
  ));
}
