import express from 'express';
import chalk from 'chalk';
import { loadConfig } from '../config';
import { NansenClient } from '../nansen/client';
import { OnchainOsClient } from '../onchainos/client';
import { createNansenSkills } from './skills';
import { logger } from '../utils/logger';
import { SkillDefinition } from '../onchainos/types';

const PORT = process.env.AGENT_PORT || 3100;

async function startAgentServer(): Promise<void> {
  const config = loadConfig();
  const nansen = new NansenClient(config.nansen.apiKey, config.nansen.baseUrl);
  const onchainOs = new OnchainOsClient(
    config.onchainOs.apiKey,
    config.onchainOs.apiSecret,
    config.onchainOs.baseUrl
  );

  const skills = createNansenSkills(nansen, onchainOs, config);
  const skillMap = new Map<string, SkillDefinition>(skills.map(s => [s.name, s]));

  const app = express();
  app.use(express.json());

  // ─── Health Check ───

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', skills: skills.map(s => s.name) });
  });

  // ─── List Skills (OnchainOS skill discovery) ───

  app.get('/skills', (_req, res) => {
    const manifest = skills.map(s => ({
      name: s.name,
      description: s.description,
      parameters: s.parameters,
    }));
    res.json({ skills: manifest });
  });

  // ─── Execute Skill ───

  app.post('/skills/:skillName', async (req, res) => {
    const { skillName } = req.params;
    const skill = skillMap.get(skillName);

    if (!skill) {
      res.status(404).json({ error: `Skill '${skillName}' not found` });
      return;
    }

    logger.info(`Executing skill: ${skillName}`);

    try {
      const result = await skill.execute(req.body);
      res.json(result);
    } catch (error) {
      logger.error(`Skill execution failed: ${error}`);
      res.status(500).json({
        success: false,
        data: null,
        message: `Execution failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  // ─── Natural Language Interface ───

  app.post('/chat', async (req, res) => {
    const { message } = req.body;

    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    logger.info(`Chat: "${message}"`);

    const intent = detectIntent(message, skills);

    if (!intent) {
      res.json({
        response: 'I can help you with smart money analysis, fund tracking, token scanning, and trading via OnchainOS. Try asking about smart money holdings or alpha signals.',
        available_skills: skills.map(s => ({ name: s.name, description: s.description })),
      });
      return;
    }

    try {
      const result = await intent.skill.execute(intent.params);
      res.json({ response: result.message, data: result.data });
    } catch (error) {
      res.status(500).json({
        response: `Sorry, I encountered an error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  app.listen(PORT, () => {
    console.log(chalk.cyan.bold(`\nNansenOS Agent Server running on port ${PORT}`));
    console.log(chalk.gray(`Available skills:`));
    skills.forEach(s => {
      console.log(chalk.gray(`  - ${s.name}: ${s.description.slice(0, 80)}...`));
    });
    console.log('');
  });
}

interface DetectedIntent {
  skill: SkillDefinition;
  params: Record<string, unknown>;
}

function detectIntent(message: string, skills: SkillDefinition[]): DetectedIntent | null {
  const lower = message.toLowerCase();

  // Alpha scan intent
  if (lower.includes('alpha') || lower.includes('signal') || lower.includes('scan') || lower.includes('opportunity')) {
    const skill = skills.find(s => s.name === 'nansen_alpha_scan');
    if (!skill) return null;
    const chainMatch = lower.match(/on\s+(ethereum|solana|polygon|arbitrum|xlayer|bsc|base)/);
    return {
      skill,
      params: {
        chains: chainMatch ? [chainMatch[1]] : 'all',
      },
    };
  }

  // Holdings intent
  if (lower.includes('holding') || lower.includes('portfolio') || lower.includes('what are.*holding')) {
    const skill = skills.find(s => s.name === 'nansen_smart_money_holdings');
    if (!skill) return null;
    return { skill, params: {} };
  }

  // Fund tracking intent
  if (lower.includes('fund') || lower.includes('institution') || lower.includes('vc')) {
    const skill = skills.find(s => s.name === 'nansen_fund_tracker');
    if (!skill) return null;
    return { skill, params: {} };
  }

  // Trade intent
  if (lower.includes('trade') || lower.includes('buy') || lower.includes('swap') || lower.includes('execute')) {
    const skill = skills.find(s => s.name === 'nansen_signal_trade');
    if (!skill) return null;
    return {
      skill,
      params: {
        auto_execute: lower.includes('execute') || lower.includes('auto'),
      },
    };
  }

  // General question - route to Nansen agent
  if (lower.includes('?') || lower.includes('what') || lower.includes('how') || lower.includes('why')) {
    const skill = skills.find(s => s.name === 'nansen_ask');
    if (!skill) return null;
    return { skill, params: { question: message } };
  }

  return null;
}

startAgentServer().catch(console.error);
