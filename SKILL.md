# HyperNansen — Hyperliquid Smart Money Intelligence Skill

> **Nansen Smart Money Data × OKX OnchainOS Hyperliquid Plugin**
> Built for OKX Build X Hackathon 2026

This skill integrates Nansen's institutional-grade Hyperliquid perp data with the OKX OnchainOS Hyperliquid plugin, letting AI agents read smart money positioning and execute perpetual futures trades.

---

## What This Skill Does

HyperNansen bridges two data layers:

1. **Nansen API** — Real-time smart money intelligence on Hyperliquid perps:
   - Which tokens are smart money (Funds, Top Traders) actively trading
   - Current long/short positioning by wallet
   - New position opens (what smart money just entered)
   - Copy trade setups from top performing traders

2. **OKX OnchainOS** — Execution via the Hyperliquid plugin:
   - Place long/short perp orders with leverage
   - Dry-run simulation mode by default (safe)
   - Live mode for real trade execution

---

## Commands

### 1. `hypernansen scan` — Smart Money Perp Scanner

Find tokens where smart money is most active on Hyperliquid perps.

```bash
hypernansen scan
hypernansen scan --hours 12 --limit 20
hypernansen scan --json
```

**Options:**
- `--hours <n>` — Lookback window (default: 24)
- `--limit <n>` — Number of tokens to show (default: 15)
- `--json` — Output raw JSON

**Output:** Table ranked by smart money net position change. Columns: Token, Net Δ, SM Longs, SM Shorts, Long Bias %, SM Volume, OI, Funding.

**Use when:** You want to know where smart money is flowing right now. High positive net change = smart money going long. High negative = going short.

---

### 2. `hypernansen sentiment <TOKEN>` — Smart Money Sentiment Signal

Get a directional signal for a specific token based on current SM positioning + 24h flow.

```bash
hypernansen sentiment BTC
hypernansen sentiment ETH
hypernansen sentiment SOL --json
```

**Signal values:** `STRONG LONG` | `LEAN LONG` | `NEUTRAL` | `LEAN SHORT` | `STRONG SHORT`

**Output:** Signal + confidence %, long/short wallet counts, L/S ratio, net position, 24h flow, and reasoning.

**Use when:** Before taking a position, check if smart money agrees with your direction.

---

### 3. `hypernansen positions <TOKEN>` — Who Is Positioned

See every smart money wallet currently long or short a token with full position details.

```bash
hypernansen positions BTC
hypernansen positions ETH --side Long
hypernansen positions SOL --side Short --limit 20
```

**Options:**
- `--side <side>` — Filter: `Long` or `Short`
- `--limit <n>` — Number of wallets to show (default: 15)
- `--json` — Output raw JSON

**Output:** Table per wallet: trader label, side, size, leverage, entry price, mark price, liquidation price, distance to liquidation %, unrealized PnL, funding paid.

**Use when:** Identify liquidation clusters or validate your thesis by seeing who's on each side.

---

### 4. `hypernansen new` — Latest Smart Money Opens

Show the most recent position **opens** by smart money wallets. Only new entries — not existing positions.

```bash
hypernansen new
hypernansen new --token BTC
hypernansen new --side Long --limit 30
hypernansen new --json
```

**Options:**
- `--token <symbol>` — Filter by token
- `--side <side>` — Filter: `Long` or `Short`
- `--limit <n>` — Number of results (default: 20)
- `--json` — Output raw JSON

**Smart money labels included:** Fund, Smart HL Perps Trader, Smart Trader. Minimum size: $5,000.

**Use when:** You want to follow smart money in real-time as they open new positions.

---

### 5. `hypernansen copy <TOKEN>` — Copy Trade Setup

Find the best smart money trader to copy on a token. Picks the trader with highest unrealized PnL, ≤20x leverage, and safe distance from liquidation.

```bash
hypernansen copy BTC
hypernansen copy ETH --side Long
hypernansen copy SOL --side Short
```

**Options:**
- `--side <side>` — Preferred direction

**Output:** Source trader label/address, direction, suggested leverage (capped at 10x for safety), entry context, trader PnL, position size, liquidation price, risk note. Includes ready-to-run execute command.

**Use when:** You want a specific copy trade to mirror.

---

### 6. `hypernansen trade` — Execute via OKX OnchainOS

Execute a perpetual trade on Hyperliquid via the OKX OnchainOS Hyperliquid plugin.

```bash
# Dry run (default — safe simulation):
hypernansen trade -t BTC -s Long -z 100 -l 5

# Limit order dry run:
hypernansen trade -t ETH -s Short -z 200 -l 3 --limit-price 3200

# Live execution (requires --live flag):
hypernansen trade -t SOL -s Long -z 50 -l 10 --live
```

**Required options:**
- `-t, --token <symbol>` — Token (BTC, ETH, SOL, etc.)
- `-s, --side <side>` — `Long` or `Short`
- `-z, --size <usd>` — Position size in USD

**Optional options:**
- `-l, --leverage <x>` — Leverage 1-20x (default: 5, capped at 20)
- `--limit-price <price>` — Limit price (omit = Market order)
- `--live` — Submit real order (default is dry run)

**Safety rules:**
- **NEVER** add `--live` without user confirmation
- Leverage is hard-capped at 20x regardless of input
- Always show the order summary and ask for confirmation before live execution
- Default mode is `DRY RUN` — safe simulation only

---

## Typical Workflows

### Follow Smart Money Into a Trade
```
1. hypernansen scan           → Find where SM is most active
2. hypernansen sentiment BTC  → Confirm direction (STRONG LONG)
3. hypernansen copy BTC       → Get copy trade setup
4. hypernansen trade -t BTC -s Long -z 100 -l 5   → Execute (dry run first)
```

### Monitor New Smart Money Entries
```
1. hypernansen new                      → See all new opens in last hour
2. hypernansen positions ETH --side Long → See who's long ETH and their sizes
3. hypernansen sentiment ETH             → Get composite signal
```

### Risk Assessment Before Trading
```
1. hypernansen positions BTC --side Short  → Find short positions
2. Look for wallets close to liquidation (Dist% < 10%) — these are squeeze targets
3. hypernansen sentiment BTC               → Confirm long bias before longing
```

---

## Agent Skill API

When running as an agent server (`npm run agent:start`), skills are accessible via HTTP:

```bash
# Health check
GET http://localhost:3100/health

# List all skills
GET http://localhost:3100/skills

# Execute a skill
POST http://localhost:3100/skills/hl_smart_money_scan
POST http://localhost:3100/skills/hl_sentiment        {"token": "BTC"}
POST http://localhost:3100/skills/hl_who_is_positioned {"token": "ETH", "side": "Long"}
POST http://localhost:3100/skills/hl_new_positions     {"limit": 20}
POST http://localhost:3100/skills/hl_copy_setup        {"token": "SOL"}
POST http://localhost:3100/skills/hl_execute_trade     {"token": "BTC", "side": "Long", "size_usd": 100, "leverage": 5}

# Natural language chat
POST http://localhost:3100/chat
{"message": "what is smart money doing on BTC"}
{"message": "show me new positions"}
{"message": "copy trade SOL"}
```

**Available skills:**
| Skill | Description |
|-------|-------------|
| `hl_smart_money_scan` | Find tokens where SM is most active |
| `hl_sentiment` | Get directional signal for a token |
| `hl_who_is_positioned` | See all SM positions on a token |
| `hl_new_positions` | Latest SM position opens |
| `hl_copy_setup` | Best trader to copy on a token |
| `hl_execute_trade` | Execute perp via OnchainOS (dry run default) |

---

## Setup

```bash
# Install
git clone https://github.com/mintttch2/OnchainOs-Nansen-CLI-Nansen-API
cd OnchainOs-Nansen-CLI-Nansen-API
npm install

# Configure
cp .env.example .env
# Edit .env with your API keys

# Build
npm run build

# Use CLI
npx hypernansen scan
npx hypernansen sentiment BTC

# Or run as agent server
npm run agent:start
```

### Required Environment Variables

```
NANSEN_API_KEY=          # From app.nansen.ai/auth/agent-setup
ONCHAINOS_API_KEY=       # From web3.okx.com/onchainos
ONCHAINOS_API_SECRET=    # From web3.okx.com/onchainos
ONCHAINOS_WALLET_ADDRESS= # Your wallet address on OnchainOS
```

---

## Critical Rules for AI Agents

**`<NEVER>`**
- Never add `--live` flag to trade commands without explicit user confirmation
- Never set leverage above 20x
- Never commit `.env` to version control

**`<MUST>`**
- Always show dry run output before suggesting live execution
- Always display the risk note from copy trade setups
- Always confirm trade details (token, side, size, leverage) before live execution

**`<SHOULD>`**
- Check sentiment before executing trades — align with smart money direction
- Check distance-to-liquidation before copying a trade (prefer >20%)
- Start with small position sizes when testing

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    HyperNansen CLI                       │
│  hypernansen scan | sentiment | positions | new | copy  │
│  hypernansen trade (via OKX OnchainOS Hyperliquid)      │
└────────────────────┬──────────────────┬─────────────────┘
                     │                  │
         ┌───────────▼──────┐  ┌────────▼───────────┐
         │   Nansen API     │  │  OKX OnchainOS     │
         │  Hyperliquid     │  │  Hyperliquid Plugin│
         │  smart money:    │  │                    │
         │  - perp-trades   │  │  - place order     │
         │  - perp-screener │  │  - close position  │
         │  - perp-positions│  │  - set leverage    │
         └──────────────────┘  └────────────────────┘
```
