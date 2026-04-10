import ora from 'ora';
import chalk from 'chalk';
import { loadConfig } from '../../config';
import { NansenClient } from '../../nansen/client';

interface AgentOptions {
  expert?: boolean;
}

export async function agentCommand(question: string, options: AgentOptions): Promise<void> {
  const config = loadConfig();
  const nansen = new NansenClient(config.nansen.apiKey, config.nansen.baseUrl);
  const tier = options.expert ? 'expert' : 'fast';

  const spinner = ora(`Asking Nansen ${tier} agent...`).start();

  try {
    const response = await nansen.askAgent({ prompt: question }, tier);

    spinner.succeed(`Answer received (confidence: ${(response.confidence * 100).toFixed(0)}%)`);

    console.log(chalk.white.bold('\n--- Nansen Agent Response ---\n'));
    console.log(response.answer);

    if (response.sources.length > 0) {
      console.log(chalk.gray('\nSources:'));
      response.sources.forEach(s => console.log(chalk.gray(`  - ${s}`)));
    }
  } catch (error) {
    spinner.fail('Agent query failed');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
}
