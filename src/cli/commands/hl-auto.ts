import chalk from 'chalk';
import inquirer from 'inquirer';
import Table from 'cli-table3';
import { loadConfig } from '../../config';
import { NansenHyperliquidClient } from '../../nansen/hyperliquid-client';
import { OnchainOsHyperliquidClient } from '../../onchainos/hyperliquid-client';
import { SmartMoneyAutoTrader, CycleResult } from '../../strategies/auto-trader';
import { RiskLevel } from '../../strategies/risk-manager';
import { formatUsd } from '../../utils/formatting';

interface AutoOptions {
  interval: string;
  risk: string;
  maxTrade: string;
  maxPositions: string;
  maxExposure: string;
  stopLoss: string;
  takeProfit: string;
  trailingStop: string;
  lookback: string;
  tokens: string;
  live?: boolean;
}

export async function autoCommand(options: AutoOptions): Promise<void> {
  const config = loadConfig();
  const dryRun = !options.live;
  const risk = (options.risk as RiskLevel) || config.agent.riskLevel || 'medium';

  const nansenHL = new NansenHyperliquidClient(config.nansen.apiKey, config.nansen.baseUrl);
  const onchainHL = new OnchainOsHyperliquidClient(
    config.onchainOs.apiKey,
    config.onchainOs.apiSecret,
    config.onchainOs.baseUrl,
    dryRun
  );

  const trader = new SmartMoneyAutoTrader(nansenHL, onchainHL, config, {
    scanIntervalMinutes: parseInt(options.interval),
    topTokensToScan: parseInt(options.tokens),
    lookbackHours: parseInt(options.lookback),
    riskLevel: risk,
    maxTradeSizeUsd: parseInt(options.maxTrade),
  });

  const riskConfig = trader.getRiskManager().config;

  // Startup banner
  console.log(chalk.cyan.bold('\n╔══════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan.bold('║') + chalk.white.bold('   HyperNansen Auto-Trader — Smart Money Perp Engine    ') + chalk.cyan.bold('║'));
  console.log(chalk.cyan.bold('╚══════════════════════════════════════════════════════════╝'));
  console.log('');
  console.log(`  Mode:            ${dryRun ? chalk.yellow.bold('DRY RUN (simulated)') : chalk.red.bold('LIVE TRADING')}`);
  console.log(`  Risk Level:      ${chalk.white.bold(risk)}`);
  console.log(`  Scan Interval:   ${chalk.white(options.interval + ' minutes')}`);
  console.log(`  Lookback:        ${chalk.white(options.lookback + ' hours')}`);
  console.log(`  Tokens/Scan:     ${chalk.white(options.tokens)}`);
  console.log('');
  console.log(chalk.white('  Position Limits:'));
  console.log(`    Max positions:  ${chalk.white(String(riskConfig.maxPositions))}`);
  console.log(`    Max exposure:   ${chalk.white(formatUsd(riskConfig.maxExposureUsd))}`);
  console.log(`    Max per trade:  ${chalk.white(formatUsd(riskConfig.maxPerTradeUsd))}`);
  console.log(`    Max leverage:   ${chalk.white(riskConfig.maxLeverage + 'x')}`);
  console.log('');
  console.log(chalk.white('  Exit Rules:'));
  console.log(`    Stop loss:      ${chalk.red('-' + riskConfig.stopLossPct + '%')}`);
  console.log(`    Take profit:    ${chalk.green('+' + riskConfig.takeProfitPct + '%')}`);
  console.log(`    Trailing stop:  ${chalk.yellow(riskConfig.trailingStopPct + '% from peak')}`);
  console.log(`    Max drawdown:   ${chalk.red(riskConfig.maxDrawdownPct + '% (circuit breaker)')}`);
  console.log(`    Min score:      ${chalk.white(String(riskConfig.minScoreToEnter) + '/100')}`);
  console.log(`    Cooldown:       ${chalk.white(riskConfig.cooldownMinutes + 'm per token')}`);
  console.log('');

  // Confirmation for live mode
  if (!dryRun) {
    console.log(chalk.red.bold('  ⚠ LIVE MODE — Real orders will be placed on Hyperliquid'));
    console.log(chalk.red('  This bot will autonomously open and close perp positions.'));
    console.log('');

    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: 'Start LIVE auto-trading? This will use real funds.',
      default: false,
    }]);

    if (!confirm) {
      console.log(chalk.yellow('Cancelled.'));
      return;
    }
  }

  // Register cycle display
  trader.onCycle((result) => {
    printCycleResult(result, trader);
  });

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    console.log(chalk.yellow('\n\nShutting down auto-trader...'));
    trader.stop();
    const stats = trader.getPortfolio().getStats();
    console.log(chalk.cyan.bold('\n── Final Performance ──'));
    console.log(trader.getPortfolio().getSummary());
    process.exit(0);
  });

  // Start the loop
  await trader.start();
}

function printCycleResult(result: CycleResult, trader: SmartMoneyAutoTrader): void {
  const positions = trader.getActivePositions();
  const stats = trader.getPortfolio().getStats();

  console.log('');
  console.log(chalk.cyan(`── Cycle #${result.cycleNumber} | ${new Date(result.timestamp).toISOString().slice(11, 19)} UTC ──`));

  // Top opportunities
  if (result.opportunities.length > 0) {
    const top = result.opportunities
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const oppTable = new Table({
      head: ['Token', 'Side', 'Score', 'Sentiment', 'SM Opens', 'Status'].map(h => chalk.gray(h)),
    });

    for (const o of top) {
      const sideColor = o.side === 'Long' ? chalk.green : chalk.red;
      const scoreColor = o.score >= 75 ? chalk.green.bold : o.score >= 55 ? chalk.yellow : chalk.gray;
      const status = result.tradesOpened.includes(o.token)
        ? chalk.green.bold('ENTERED')
        : o.score >= trader.getRiskManager().config.minScoreToEnter
          ? chalk.yellow('READY')
          : chalk.gray('low score');

      oppTable.push([
        chalk.cyan(o.token),
        sideColor(o.side),
        scoreColor(String(o.score)),
        o.sentiment.signal.replace('_', ' '),
        String(o.recentOpens),
        status,
      ]);
    }

    console.log(oppTable.toString());
  }

  // Actions taken
  if (result.tradesOpened.length > 0) {
    console.log(chalk.green.bold(`  Opened: ${result.tradesOpened.join(', ')}`));
  }
  if (result.tradesClosed.length > 0) {
    console.log(chalk.red(`  Closed: ${result.tradesClosed.join(', ')}`));
  }
  if (result.errors.length > 0) {
    for (const err of result.errors.slice(0, 3)) {
      console.log(chalk.red(`  Error: ${err}`));
    }
  }

  // Open positions table
  if (positions.length > 0) {
    const posTable = new Table({
      head: ['Token', 'Side', 'Size', 'Lev', 'Entry', 'PnL %', 'Peak %', 'Hold', 'Score'].map(h => chalk.gray(h)),
    });

    for (const p of positions) {
      const sideColor = p.side === 'Long' ? chalk.green : chalk.red;
      const pnlColor = p.currentPnlPct >= 0 ? chalk.green : chalk.red;
      const holdMin = Math.round((Date.now() - p.entryTime.getTime()) / 60_000);

      posTable.push([
        chalk.white.bold(p.token),
        sideColor(p.side),
        formatUsd(p.sizeUsd),
        `${p.leverage}x`,
        `$${p.entryPrice.toFixed(2)}`,
        pnlColor(`${p.currentPnlPct >= 0 ? '+' : ''}${p.currentPnlPct.toFixed(2)}%`),
        chalk.yellow(`${p.peakPnlPct.toFixed(2)}%`),
        `${holdMin}m`,
        String(p.signalScore),
      ]);
    }

    console.log(posTable.toString());
  }

  // Stats line
  const wr = stats.closedTrades > 0 ? `${stats.winRate.toFixed(0)}%` : '-';
  console.log(chalk.gray(
    `  Pos: ${positions.length} open | ` +
    `Trades: ${stats.closedTrades} (${stats.wins}W/${stats.losses}L, WR: ${wr}) | ` +
    `PnL: ${formatUsd(stats.totalPnlUsd)} | ` +
    `DD: ${stats.maxDrawdownPct.toFixed(1)}%`
  ));
}
