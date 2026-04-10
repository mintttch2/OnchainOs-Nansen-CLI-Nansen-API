import ora from 'ora';
import chalk from 'chalk';
import Table from 'cli-table3';
import { loadConfig } from '../../config';
import { OnchainOsClient } from '../../onchainos/client';
import { formatUsd, shortenAddress } from '../../utils/formatting';

interface WalletOptions {
  address?: string;
  chain: string;
  json?: boolean;
}

export async function walletCommand(options: WalletOptions): Promise<void> {
  const config = loadConfig();
  const onchainOs = new OnchainOsClient(
    config.onchainOs.apiKey,
    config.onchainOs.apiSecret,
    config.onchainOs.baseUrl
  );

  const address = options.address || config.onchainOs.walletAddress;
  if (!address) {
    console.log(chalk.red('No wallet address. Use -a <address> or set ONCHAINOS_WALLET_ADDRESS.'));
    process.exit(1);
  }

  const spinner = ora(`Fetching wallet info for ${shortenAddress(address)}...`).start();

  try {
    const [walletInfo, tokenBalances] = await Promise.all([
      onchainOs.getWalletInfo(address, options.chain),
      onchainOs.getTokenBalances(address, options.chain),
    ]);

    spinner.succeed('Wallet loaded');

    if (options.json) {
      console.log(JSON.stringify({ walletInfo, tokenBalances }, null, 2));
      return;
    }

    console.log(chalk.white.bold(`\n  Wallet: ${address}`));
    console.log(chalk.white(`  Chain:  ${options.chain}`));
    console.log(chalk.white(`  Balance: ${walletInfo.balance} (${formatUsd(walletInfo.balanceUsd)})`));

    if (tokenBalances.length > 0) {
      console.log(chalk.white.bold('\n  Token Balances:'));

      const table = new Table({
        head: [
          chalk.white('Token'),
          chalk.white('Balance'),
          chalk.white('Value (USD)'),
        ],
      });

      for (const t of tokenBalances) {
        table.push([
          chalk.cyan(t.tokenSymbol),
          t.balance,
          formatUsd(t.balanceUsd),
        ]);
      }

      console.log(table.toString());
    }
  } catch (error) {
    spinner.fail('Failed to fetch wallet info');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}
