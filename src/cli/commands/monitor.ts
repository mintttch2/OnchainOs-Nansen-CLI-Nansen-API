import chalk from 'chalk';
import { loadConfig } from '../../config';
import { NansenClient } from '../../nansen/client';
import { OnchainOsClient } from '../../onchainos/client';
import { AlphaDetector } from '../../strategies/alpha-detector';
import { TradeExecutor } from '../../strategies/executor';
import { logger } from '../../utils/logger';
import { formatUsd, formatTimestamp, sleep } from '../../utils/formatting';
import { AlphaSignal } from '../../strategies/types';

interface MonitorOptions {
  chain?: string[];
  interval: string;
  autoTrade?: boolean;
}

export async function monitorCommand(options: MonitorOptions): Promise<void> {
  const config = loadConfig();

  if (options.autoTrade) {
    config.agent.mode = 'auto-trade';
    console.log(chalk.red.bold('\n  AUTO-TRADE MODE ENABLED'));
    console.log(chalk.red(`  Max trade size: ${formatUsd(config.agent.maxTradeSizeUsd)}`));
    console.log(chalk.red(`  Risk level: ${config.agent.riskLevel}\n`));
  }

  const nansen = new NansenClient(config.nansen.apiKey, config.nansen.baseUrl);
  const onchainOs = new OnchainOsClient(
    config.onchainOs.apiKey,
    config.onchainOs.apiSecret,
    config.onchainOs.baseUrl
  );

  const detector = new AlphaDetector(nansen, {
    minConfidence: config.agent.smartMoneyMinConfidence,
  });
  const executor = new TradeExecutor(onchainOs, config);

  const chains = options.chain || 'all';
  const intervalMs = parseInt(options.interval) * 1000;
  const seenSignals = new Set<string>();

  console.log(chalk.cyan.bold('\nStarting Alpha Monitor'));
  console.log(chalk.gray(`  Chains: ${Array.isArray(chains) ? chains.join(', ') : 'all'}`));
  console.log(chalk.gray(`  Interval: ${options.interval}s`));
  console.log(chalk.gray(`  Mode: ${config.agent.mode}`));
  console.log(chalk.gray(`  Press Ctrl+C to stop\n`));

  let cycle = 0;
  while (true) {
    cycle++;
    console.log(chalk.gray(`\n--- Scan #${cycle} [${formatTimestamp(new Date())}] ---`));

    try {
      const signals = await detector.detectSignals(chains as string[] | 'all');
      const newSignals = signals.filter(s => !seenSignals.has(s.id));

      if (newSignals.length === 0) {
        logger.info('No new signals');
      } else {
        logger.signal(`${newSignals.length} new signal(s) detected!`);

        for (const signal of newSignals) {
          seenSignals.add(signal.id);
          printMonitorSignal(signal);
        }

        if (config.agent.mode === 'auto-trade') {
          const buySignals = newSignals.filter(s => s.action === 'buy');
          if (buySignals.length > 0) {
            logger.trade(`Auto-executing ${buySignals.length} buy signal(s)...`);
            const results = await executor.processSignals(buySignals);
            for (const r of results) {
              if (r.executed) {
                logger.trade(`Executed: ${r.signal.token.symbol} - TX: ${r.txHash}`);
              } else {
                logger.info(`Skipped: ${r.signal.token.symbol} - ${r.error}`);
              }
            }
          }
        }
      }
    } catch (error) {
      logger.error(`Scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    await sleep(intervalMs);
  }
}

function printMonitorSignal(signal: AlphaSignal): void {
  const icon = signal.action === 'buy' ? chalk.green('BUY') : chalk.gray('WATCH');
  const conf = `${(signal.confidence * 100).toFixed(0)}%`;

  console.log(
    `  ${icon} ${chalk.cyan.bold(signal.token.symbol)} ` +
    `(${signal.token.chain}) [${signal.strength}] ${conf}`
  );
  console.log(chalk.gray(`       ${signal.reasoning}`));
}
