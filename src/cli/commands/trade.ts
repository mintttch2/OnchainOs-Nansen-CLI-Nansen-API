import ora from 'ora';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { loadConfig } from '../../config';
import { OnchainOsClient } from '../../onchainos/client';
import { formatUsd } from '../../utils/formatting';

interface TradeOptions {
  token: string;
  chain: string;
  amount: string;
  execute?: boolean;
  slippage: string;
}

export async function tradeCommand(options: TradeOptions): Promise<void> {
  const config = loadConfig();
  const onchainOs = new OnchainOsClient(
    config.onchainOs.apiKey,
    config.onchainOs.apiSecret,
    config.onchainOs.baseUrl
  );

  const walletAddress = config.onchainOs.walletAddress;
  if (!walletAddress) {
    console.log(chalk.red('ONCHAINOS_WALLET_ADDRESS not set in .env'));
    process.exit(1);
  }

  // Step 1: Get quote
  const spinner = ora(`Getting swap quote for ${options.token}...`).start();

  try {
    const nativeToken = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
    const quote = await onchainOs.getSwapQuote({
      chainId: options.chain,
      fromTokenAddress: nativeToken,
      toTokenAddress: options.token,
      amount: options.amount,
      slippage: options.slippage,
      userWalletAddress: walletAddress,
    });

    spinner.succeed('Quote received');

    console.log(chalk.white.bold('\n--- Swap Quote ---'));
    console.log(`  From: ${quote.fromAmount} ${quote.fromToken.symbol}`);
    console.log(`  To:   ${quote.toAmount} ${quote.toToken.symbol}`);
    console.log(`  Price Impact: ${quote.priceImpact}%`);
    console.log(`  Est. Gas: ${quote.estimatedGas}`);
    console.log(`  Route: ${quote.route.map(r => `${r.dex} (${r.percentage}%)`).join(' -> ')}`);

    // Step 2: Execute if requested
    if (!options.execute) {
      console.log(chalk.gray('\n  Use --execute to submit the transaction.'));
      return;
    }

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Execute swap of ${formatUsd(parseFloat(options.amount))} for ${quote.toToken.symbol}?`,
        default: false,
      },
    ]);

    if (!confirm) {
      console.log(chalk.yellow('Trade cancelled.'));
      return;
    }

    const execSpinner = ora('Executing swap via OnchainOS...').start();

    const result = await onchainOs.executeSwap({
      chainId: options.chain,
      fromTokenAddress: nativeToken,
      toTokenAddress: options.token,
      amount: options.amount,
      slippage: options.slippage,
      userWalletAddress: walletAddress,
    });

    execSpinner.succeed('Swap executed!');
    console.log(chalk.green.bold(`\n  TX: ${result.txHash}`));
    console.log(chalk.gray(`  Status: ${result.status}`));
  } catch (error) {
    spinner.fail('Trade failed');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}
