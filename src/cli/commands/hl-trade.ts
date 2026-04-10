import ora from 'ora';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { loadConfig } from '../../config';
import { OnchainOsHyperliquidClient } from '../../onchainos/hyperliquid-client';
import { formatUsd } from '../../utils/formatting';

interface TradeOptions {
  token: string;
  side: string;
  size: string;
  leverage: string;
  limitPrice?: string;
  live?: boolean;
}

export async function tradeCommand(options: TradeOptions): Promise<void> {
  const config = loadConfig();
  const dryRun = !options.live;

  const onchainHL = new OnchainOsHyperliquidClient(
    config.onchainOs.apiKey,
    config.onchainOs.apiSecret,
    config.onchainOs.baseUrl,
    dryRun
  );

  const token = options.token.toUpperCase();
  const side = options.side as 'Long' | 'Short';
  const sizeUsd = parseFloat(options.size);
  const leverage = Math.min(parseInt(options.leverage), 20);
  const orderType = options.limitPrice ? 'Limit' : 'Market';

  if (!['Long', 'Short'].includes(side)) {
    console.error(chalk.red('Side must be "Long" or "Short"'));
    process.exit(1);
  }

  const sideColor = side === 'Long' ? chalk.green : chalk.red;

  console.log(chalk.white.bold('\n── Order Summary ──────────────────────────'));
  console.log(`Token:      ${chalk.cyan(token)}`);
  console.log(`Side:       ${sideColor.bold(side)}`);
  console.log(`Size:       ${formatUsd(sizeUsd)}`);
  console.log(`Leverage:   ${leverage}x`);
  console.log(`Type:       ${orderType}`);
  if (options.limitPrice) console.log(`Limit:      $${parseFloat(options.limitPrice).toFixed(2)}`);
  console.log(`Mode:       ${dryRun ? chalk.yellow('DRY RUN') : chalk.red.bold('LIVE')}`);
  console.log('─'.repeat(44));

  if (!dryRun) {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Submit LIVE ${side} ${token} ${formatUsd(sizeUsd)} @ ${leverage}x on Hyperliquid?`,
      default: false,
    }]);
    if (!confirm) { console.log(chalk.yellow('Cancelled.')); return; }
  }

  const spinner = ora(`${dryRun ? 'Simulating' : 'Executing'} ${side} ${token}...`).start();

  try {
    const result = await onchainHL.placeOrder({
      token_symbol: token,
      side,
      order_type: orderType,
      size_usd: sizeUsd,
      leverage,
      limit_price: options.limitPrice ? parseFloat(options.limitPrice) : undefined,
    });

    if (dryRun) {
      spinner.warn(`[DRY RUN] Simulated — no real order placed`);
    } else {
      spinner.succeed(`Order ${result.status}: ${result.order_id}`);
    }

    console.log('');
    console.log(`Status:     ${result.status}`);
    console.log(`Order ID:   ${result.order_id}`);
    if (result.avg_fill_price > 0) console.log(`Fill Price: $${result.avg_fill_price.toFixed(2)}`);
    console.log(`Est. Fee:   ${formatUsd(result.fee_usd)}`);

    if (dryRun) {
      console.log(chalk.yellow('\nTo submit a real order, add --live flag'));
    }
  } catch (err) {
    spinner.fail('Trade failed');
    console.error(chalk.red(String(err)));
    process.exit(1);
  }
}
