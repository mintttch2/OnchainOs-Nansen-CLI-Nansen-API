import express from 'express';
import chalk from 'chalk';
import { loadConfig } from '../config';
import { NansenHyperliquidClient } from '../nansen/hyperliquid-client';
import { OnchainOsHyperliquidClient } from '../onchainos/hyperliquid-client';
import { createHyperliquidSkills } from './hyperliquid-skills';
import { logger } from '../utils/logger';
import { SkillDefinition } from '../onchainos/types';

const PORT = process.env.AGENT_PORT || 3100;

async function startAgentServer(): Promise<void> {
  const config = loadConfig();
  const dryRun = config.agent.mode !== 'auto-trade';

  const nansenHL = new NansenHyperliquidClient(config.nansen.apiKey, config.nansen.baseUrl);
  const onchainHL = new OnchainOsHyperliquidClient(
    config.onchainOs.apiKey,
    config.onchainOs.apiSecret,
    config.onchainOs.baseUrl,
    dryRun
  );

  const skills = createHyperliquidSkills(nansenHL, onchainHL, config);
  const skillMap = new Map<string, SkillDefinition>(skills.map(s => [s.name, s]));

  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', agent: 'HyperNansen', mode: config.agent.mode, dry_run: dryRun, skills: skills.map(s => s.name) });
  });

  app.get('/skills', (_req, res) => {
    res.json({ skills: skills.map(s => ({ name: s.name, description: s.description, parameters: s.parameters })) });
  });

  app.post('/skills/:skillName', async (req, res) => {
    const { skillName } = req.params;
    const skill = skillMap.get(skillName);
    if (!skill) { res.status(404).json({ error: `Skill '${skillName}' not found` }); return; }
    logger.info(`Executing skill: ${skillName}`);
    try {
      const result = await skill.execute(req.body);
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, data: null, message: String(err) });
    }
  });

  app.post('/chat', async (req, res) => {
    const { message } = req.body as { message?: string };
    if (!message) { res.status(400).json({ error: 'message is required' }); return; }
    logger.info(`Chat: "${message}"`);
    const intent = detectIntent(message.toLowerCase());
    if (!intent) {
      res.json({
        response: 'Try: "scan smart money perps" | "BTC sentiment" | "who is long ETH" | "new positions" | "copy trade SOL"',
        skills: skills.map(s => s.name),
      });
      return;
    }
    const skill = skillMap.get(intent.skillName);
    if (!skill) { res.status(500).json({ error: 'Skill not found' }); return; }
    try {
      const result = await skill.execute(intent.params);
      res.json({ response: result.message, data: result.data });
    } catch (err) {
      res.status(500).json({ response: String(err) });
    }
  });

  app.listen(PORT, () => {
    console.log(chalk.cyan.bold(`\nHyperNansen Agent — :${PORT} | Mode: ${config.agent.mode} | Dry run: ${dryRun}`));
    console.log(chalk.gray(`Skills: ${skills.map(s => s.name).join(', ')}\n`));
  });
}

function detectIntent(msg: string): { skillName: string; params: Record<string, unknown> } | null {
  const knownTokens = ['BTC', 'ETH', 'SOL', 'ARB', 'OP', 'AVAX', 'DOGE', 'LINK', 'UNI', 'HYPE', 'WIF', 'PENGU'];
  const token = knownTokens.find(t => msg.includes(t.toLowerCase()));
  const side = msg.includes('long') ? 'Long' : msg.includes('short') ? 'Short' : undefined;

  if (msg.match(/scan|where.*smart money|top perp|active/)) return { skillName: 'hl_smart_money_scan', params: {} };
  if (msg.match(/new position|just open|latest|recent/)) return { skillName: 'hl_new_positions', params: { token, side } };
  if (token && msg.match(/sentiment|think|bullish|bearish|bias/)) return { skillName: 'hl_sentiment', params: { token } };
  if (token && msg.match(/who is|position|holding/)) return { skillName: 'hl_who_is_positioned', params: { token, side } };
  if (msg.match(/copy|follow|which trader/)) return { skillName: 'hl_copy_setup', params: { token, preferred_side: side } };
  if (token && msg.match(/trade|execute|open|buy|sell/)) return { skillName: 'hl_execute_trade', params: { token, side: side ?? 'Long', size_usd: 100, leverage: 5 } };
  return null;
}

startAgentServer().catch(console.error);
