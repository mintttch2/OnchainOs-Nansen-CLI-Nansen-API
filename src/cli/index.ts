#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, validateConfig } from '../config';
import { scanCommand } from './commands/scan';
import { holdingsCommand } from './commands/holdings';
import { tradeCommand } from './commands/trade';
import { monitorCommand } from './commands/monitor';
import { walletCommand } from './commands/wallet';
import { agentCommand } from './commands/agent';

const program = new Command();

const BANNER = `
${chalk.cyan.bold('╔══════════════════════════════════════════════════════════╗')}
${chalk.cyan.bold('║')}  ${chalk.white.bold('NansenOS Alpha Agent')}                                    ${chalk.cyan.bold('║')}
${chalk.cyan.bold('║')}  ${chalk.gray('Nansen Smart Money Intelligence × OKX OnchainOS')}         ${chalk.cyan.bold('║')}
${chalk.cyan.bold('║')}  ${chalk.gray('Discover alpha. Execute on-chain. Autonomously.')}         ${chalk.cyan.bold('║')}
${chalk.cyan.bold('╚══════════════════════════════════════════════════════════╝')}
`;

program
  .name('nansen-os')
  .version('1.0.0')
  .description('AI Agent combining Nansen Smart Money data with OKX OnchainOS execution')
  .addHelpText('before', BANNER)
  .hook('preAction', () => {
    const config = loadConfig();
    const errors = validateConfig(config);
    if (errors.length > 0) {
      console.log(chalk.yellow('\nConfiguration warnings:'));
      errors.forEach(e => console.log(chalk.yellow(`  - ${e}`)));
      console.log(chalk.gray('  Run with --help or check .env.example\n'));
    }
  });

// ─── Commands ───

program
  .command('scan')
  .description('Scan for smart money alpha signals')
  .option('-c, --chain <chains...>', 'Chains to scan (default: all)')
  .option('-l, --limit <number>', 'Max signals to show', '20')
  .option('--min-confidence <number>', 'Minimum confidence threshold (0-1)', '0.7')
  .option('--json', 'Output as JSON')
  .action(scanCommand);

program
  .command('holdings')
  .description('View top smart money holdings')
  .option('-c, --chain <chains...>', 'Chains to filter')
  .option('-l, --limit <number>', 'Number of results', '20')
  .option('--json', 'Output as JSON')
  .action(holdingsCommand);

program
  .command('trade')
  .description('Get swap quote or execute trade via OnchainOS')
  .requiredOption('-t, --token <address>', 'Token address to buy')
  .option('-c, --chain <chain>', 'Chain', 'xlayer')
  .option('-a, --amount <usd>', 'Amount in USD', '100')
  .option('--execute', 'Actually execute the trade (default: quote only)')
  .option('--slippage <percent>', 'Max slippage %', '1.0')
  .action(tradeCommand);

program
  .command('wallet')
  .description('Check wallet balances via OnchainOS')
  .option('-a, --address <address>', 'Wallet address (default: from config)')
  .option('-c, --chain <chain>', 'Chain', 'xlayer')
  .option('--json', 'Output as JSON')
  .action(walletCommand);

program
  .command('monitor')
  .description('Continuously monitor smart money and alert on signals')
  .option('-c, --chain <chains...>', 'Chains to monitor')
  .option('-i, --interval <seconds>', 'Scan interval in seconds', '300')
  .option('--auto-trade', 'Enable automatic trade execution')
  .action(monitorCommand);

program
  .command('agent')
  .description('Ask Nansen AI agent a question about on-chain data')
  .argument('<question>', 'Question to ask')
  .option('--expert', 'Use expert tier (750 credits)')
  .action(agentCommand);

program.parse();
