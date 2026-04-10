import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../../config';
import { NansenHyperliquidClient } from '../../nansen/hyperliquid-client';
import { formatUsd } from '../../utils/formatting';

interface CopyOptions { side?: string; }

export async function copyCommand(token: string, options: CopyOptions): Promise<void> {
  const config = loadConfig();
  const hl = new NansenHyperliquidClient(config.nansen.apiKey, config.nansen.baseUrl);
  const sym = token.toUpperCase();
  const spinner = ora(`Finding best smart money trader to copy on ${sym}...`).start();

  try {
    const setup = await hl.getCopyTradeSetup(sym, options.side as 'Long' | 'Short' | undefined);

    if (!setup) {
      spinner.warn(`No suitable copy trade found for ${sym}`);
      return;
    }

    spinner.succeed('Found copy trade setup');

    const sideColor = setup.side === 'Long' ? chalk.green : chalk.red;

    console.log(`\n${chalk.cyan.bold('Copy Trade Setup — ' + sym)}`);
    console.log('─'.repeat(50));
    console.log(`Source Trader:  ${chalk.cyan(setup.source_label)}`);
    console.log(`Address:        ${chalk.gray(setup.source_trader)}`);
    console.log(`Direction:      ${sideColor.bold(setup.side)}`);
    console.log(`Leverage:       ${setup.suggested_leverage}x (capped from source for safety)`);
    console.log(`Entry Context:  ${setup.entry_context}`);
    console.log('');
    console.log(`Trader PnL:     ${chalk.green(formatUsd(setup.trader_unrealized_pnl_usd))}`);
    console.log(`Position Size:  ${formatUsd(setup.trader_position_value_usd)}`);
    console.log(`Liq. Price:     $${setup.liquidation_price.toFixed(2)}`);
    console.log('');
    console.log(chalk.yellow(`Risk: ${setup.risk_note}`));
    console.log('');
    console.log(chalk.gray(`To execute: hypernansen trade -t ${sym} -s ${setup.side} -z 100 -l ${setup.suggested_leverage}`));
  } catch (err) {
    spinner.fail('Failed');
    console.error(chalk.red(String(err)));
    process.exit(1);
  }
}
