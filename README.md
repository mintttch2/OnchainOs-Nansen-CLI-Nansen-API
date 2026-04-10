# NansenOS Alpha Agent

**AI Agent that combines Nansen Smart Money Intelligence with OKX OnchainOS for automated on-chain alpha discovery and execution.**

Built for the [OKX Build X Hackathon 2026](https://web3.okx.com/xlayer/build-x-hackathon) — X Layer Arena + Skills Arena tracks.

---

## What It Does

NansenOS Alpha Agent bridges **Nansen's smart money analytics** with **OKX OnchainOS's trading infrastructure** to create an autonomous AI agent that can:

1. **Detect Alpha** — Scans Nansen's Smart Money data (netflows, holdings, DEX trades) to identify tokens being accumulated by funds, whales, and top traders
2. **Score Signals** — Applies multi-factor analysis with confidence scoring and signal convergence detection
3. **Execute Trades** — Routes orders through OnchainOS DEX aggregator for optimal execution across chains (including X Layer)
4. **Monitor Continuously** — Runs as a persistent agent that watches for new signals and can auto-trade

```
Nansen Smart Money Data ──> Alpha Detection Engine ──> Signal Scoring
                                                            │
                                                            v
OKX OnchainOS DEX ◄──── Trade Execution ◄──── Buy/Watch Decision
```

## Architecture

```
src/
├── nansen/           # Nansen API client (Smart Money, Token Screener, Agent)
├── onchainos/        # OKX OnchainOS client (Wallet, Trade, Market)
├── strategies/       # Alpha detection & trade execution logic
│   ├── alpha-detector.ts   # Multi-strategy signal detection
│   └── executor.ts         # Signal-to-trade pipeline
├── agent/            # OnchainOS Skill server (HTTP + natural language)
│   ├── skills.ts           # 5 reusable skills for OnchainOS
│   ├── server.ts           # Express server with chat interface
│   └── skill-manifest.json # Skill discovery manifest
├── cli/              # Interactive CLI tool
│   └── commands/     # scan, holdings, trade, wallet, monitor, agent
├── config/           # Environment config management
└── utils/            # Logger, formatting helpers
```

## Quick Start

### 1. Install

```bash
git clone https://github.com/mintttch2/onchainos-nansen-cli-nansen-api.git
cd onchainos-nansen-cli-nansen-api
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your API keys:
#   NANSEN_API_KEY=...
#   ONCHAINOS_API_KEY=...
#   ONCHAINOS_API_SECRET=...
```

### 3. Use CLI

```bash
# Scan for smart money alpha signals
npx ts-node src/cli/index.ts scan

# Scan specific chains
npx ts-node src/cli/index.ts scan --chain ethereum solana

# View smart money holdings
npx ts-node src/cli/index.ts holdings

# Get a trade quote via OnchainOS
npx ts-node src/cli/index.ts trade -t 0xTokenAddress -c xlayer -a 100

# Check wallet balance
npx ts-node src/cli/index.ts wallet -c xlayer

# Start continuous monitoring
npx ts-node src/cli/index.ts monitor --interval 300

# Ask Nansen AI agent
npx ts-node src/cli/index.ts agent "What tokens are funds buying on Solana?"
```

### 4. Run Agent Server

```bash
# Start the OnchainOS skill server
npx ts-node src/agent/server.ts

# The server exposes:
# GET  /health            - Health check
# GET  /skills            - List available skills
# POST /skills/:name      - Execute a skill
# POST /chat              - Natural language interface
```

## Alpha Detection Strategies

The agent uses 4 complementary strategies that combine for higher accuracy:

| Strategy | Data Source | What It Detects |
|----------|-----------|----------------|
| **Smart Money Accumulation** | Nansen Netflows | Tokens with strong net inflows from smart money + multiple traders |
| **Fund Conviction** | Nansen Holdings | Tokens where smart money holdings are growing rapidly |
| **DEX Buy Pressure** | Nansen DEX Trades | Tokens with high smart money buy/sell ratio on DEXes |
| **Multi-Signal Convergence** | All above | Tokens flagged by 2+ independent strategies (boosted confidence) |

### Confidence Scoring

Each signal gets a **0-100% confidence score** based on:
- Net flow magnitude (how much money is flowing in)
- Trader count (how many smart wallets are involved)
- Consistency (are 7d and 24h flows aligned?)
- Market cap (smaller caps = higher alpha potential)
- Buy pressure ratio (buyers vs sellers)

Signals with 2+ strategies converging get a **20% confidence boost**.

## OnchainOS Skills

Five reusable skills that any OnchainOS agent can integrate:

| Skill | Description | Credits |
|-------|------------|---------|
| `nansen_alpha_scan` | Detect alpha signals from smart money data | 5 |
| `nansen_smart_money_holdings` | View top smart money holdings | 5 |
| `nansen_fund_tracker` | Track fund buying/selling activity | 5 |
| `nansen_signal_trade` | Detect signal + get/execute swap quote | 10 |
| `nansen_ask` | Ask Nansen AI about on-chain data | 200-750 |

### Example: Using Skills Programmatically

```typescript
import { NansenClient, OnchainOsClient, createNansenSkills, loadConfig } from 'nansen-onchainos-alpha-agent';

const config = loadConfig();
const nansen = new NansenClient(config.nansen.apiKey);
const onchainOs = new OnchainOsClient(config.onchainOs.apiKey, config.onchainOs.apiSecret);
const skills = createNansenSkills(nansen, onchainOs, config);

// Execute alpha scan
const scanner = skills.find(s => s.name === 'nansen_alpha_scan')!;
const result = await scanner.execute({ chains: ['ethereum', 'xlayer'], min_confidence: 0.8 });
console.log(result.data);
```

## CLI Commands

| Command | Description |
|---------|------------|
| `scan` | Scan for smart money alpha signals with confidence scoring |
| `holdings` | View top smart money holdings across chains |
| `trade` | Get swap quote or execute trade via OnchainOS DEX aggregator |
| `wallet` | Check wallet balances via OnchainOS |
| `monitor` | Continuous monitoring with optional auto-trade |
| `agent` | Ask Nansen AI agent natural language questions |

## How This Fits the Hackathon

### X Layer Arena
- Trades execute through OnchainOS DEX aggregator with X Layer as default chain
- Agent monitors and trades autonomously on X Layer
- Full-stack: data intelligence (Nansen) + execution (OnchainOS) + AI agent

### Skills Arena
- 5 reusable skills any OnchainOS agent can integrate
- Skill manifest for discovery
- Natural language chat interface
- HTTP API for programmatic access

## Tech Stack

- **TypeScript** — Type-safe codebase
- **Nansen API** — Smart money data, token screening, AI agent
- **OKX OnchainOS** — Wallet, DEX aggregation, market data
- **Express** — Agent skill server
- **Commander** — CLI framework
- **Ethers.js** — Blockchain interaction utilities

## Safety Features

- **Three modes**: `monitor` (watch only), `alert` (notify), `auto-trade` (execute)
- **Confidence thresholds** — Only trades above configurable confidence level
- **Max trade size** — Configurable USD limit per trade
- **Risk levels** — Low/medium/high risk profiles
- **Dry run by default** — Must explicitly enable auto-trade mode
- **Interactive confirmation** — CLI asks for confirmation before executing

## License

MIT
