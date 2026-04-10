import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../../config';
import { NansenHyperliquidClient } from '../../nansen/hyperliquid-client';
import { formatUsd } from '../../utils/formatting';

interface SentimentOptions { json?: boolean; }

export async function sentimentCommand(token: string, options: SentimentOptions): Promise<void> {
  const config = loadConfig();
  const hl = new NansenHyperliquidClient(config.nansen.apiKey, config.nansen.baseUrl);
  const sym = token.toUpperCase();
  const spinner = ora(`Computing smart money sentiment for ${sym}...`).start();

  try {
    const s = await hl.getSmartMoneySentiment(sym);
    spinner.succeed(`Sentiment computed`);

    if (options.json) { console.log(JSON.stringify(s, null, 2)); return; }

    const signalColors: Record<string, chalk.Chalk> = {
      strong_long: chalk.green.bold,
      lean_long: chalk.green,
      neutral: chalk.yellow,
      lean_short: chalk.red,
      strong_short: chalk.red.bold,
    };
    const signalLabels: Record<string, string> = {
      strong_long: '>>> STRONG LONG',
      lean_long: '>>  LEAN LONG',
      neutral: '—   NEUTRAL',
      lean_short: '<<  LEAN SHORT',
      strong_short: '<<< STRONG SHORT',
    };

    const color = signalColors[s.signal] ?? chalk.white;
    const label = signalLabels[s.signal] ?? s.signal;

    console.log(`\n${chalk.cyan.bold(sym)} Smart Money Sentiment`);
    console.log('─'.repeat(50));
    console.log(`Signal:       ${color(label)}`);
    console.log(`Confidence:   ${(s.confidence * 100).toFixed(0)}%`);
    console.log('');
    console.log(`SM Longs:     ${s.smart_money_longs_count} wallets  (${chalk.green(formatUsd(s.smart_money_long_usd))})`);
    console.log(`SM Shorts:    ${s.smart_money_shorts_count} wallets  (${chalk.red(formatUsd(s.smart_money_short_usd))})`);
    console.log(`L/S Ratio:    ${s.long_short_ratio.toFixed(2)}x`);
    console.log(`Net Position: ${s.net_position_usd >= 0 ? chalk.green(formatUsd(s.net_position_usd)) : chalk.red(formatUsd(s.net_position_usd))}`);
    console.log('');
    console.log(`24h Flow:     Buy ${s.buy_pressure_pct.toFixed(0)}% / Sell ${(100 - s.buy_pressure_pct).toFixed(0)}%`);
    console.log(`Net 24h:      ${s.net_flow_24h_usd >= 0 ? chalk.green('+' + formatUsd(s.net_flow_24h_usd)) : chalk.red(formatUsd(s.net_flow_24h_usd))}`);
    console.log('');
    console.log(chalk.gray(s.reasoning));
  } catch (err) {
    spinner.fail('Failed');
    console.error(chalk.red(String(err)));
    process.exit(1);
  }
}
