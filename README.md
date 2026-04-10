# HyperNansen

**Hyperliquid Smart Money Intelligence — Nansen perp data × OKX OnchainOS Hyperliquid plugin.**

Built for the [OKX Build X Hackathon 2026](https://web3.okx.com/xlayer/build-x-hackathon) — Skills Arena track.

---

## What It Does

HyperNansen connects two best-in-class systems:

| Layer | Technology | What it provides |
|-------|-----------|-----------------|
| **Intelligence** | [Nansen API](https://docs.nansen.ai/api/hyperliquid) | Real-time smart money perp positioning on Hyperliquid |
| **Execution** | [OKX OnchainOS](https://web3.okx.com/onchainos/plugins/detail/hyperliquid) | Hyperliquid perp trade execution via AI plugin |

**The result:** An AI agent + CLI that reads where smart money (Funds, top traders) is positioned on Hyperliquid and can execute copy trades through OnchainOS — with dry-run safety by default.

```
Nansen Hyperliquid perp data ──> Smart Money Positioning
         │                              │
         ▼                              ▼
  Sentiment Signal              Copy Trade Setup
  (STRONG LONG / SHORT)         (best trader, safe leverage)
         │                              │
         └──────────────┬───────────────┘
                        ▼
         OKX OnchainOS Hyperliquid Plugin
           (place order, set leverage)
```

---

## Features

### CLI (`hypernansen`)

| Command | What it does |
|---------|-------------|
| `scan` | Find tokens where smart money is most active on HL perps |
| `sentiment <TOKEN>` | Get `STRONG LONG` / `LEAN SHORT` signal with confidence % |
| `positions <TOKEN>` | See which SM wallets are long/short with PnL + liq distance |
| `new` | Latest smart money position opens (real-time entries) |
| `copy <TOKEN>` | Find best trader to copy — highest PnL, safe leverage |
| `trade` | Execute long/short via OKX OnchainOS (dry run by default) |

### Agent Skills (6 skills)

| Skill | Description |
|-------|-------------|
| `hl_smart_money_scan` | Ranked SM activity across all HL perp tokens |
| `hl_sentiment` | Composite signal from positioning + 24h flow data |
| `hl_who_is_positioned` | Per-wallet view: size, entry, liq, PnL |
| `hl_new_positions` | Real-time SM opens (Fund/Smart Trader labels only) |
| `hl_copy_setup` | Top trader recommendation with risk assessment |
| `hl_execute_trade` | Order execution via OnchainOS (dry run default) |

---

## Quick Start

### Install

```bash
git clone https://github.com/mintttch2/OnchainOs-Nansen-CLI-Nansen-API
cd OnchainOs-Nansen-CLI-Nansen-API
npm install
npm run build
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:
```
NANSEN_API_KEY=...         # https://app.nansen.ai/auth/agent-setup
ONCHAINOS_API_KEY=...      # https://web3.okx.com/onchainos
ONCHAINOS_API_SECRET=...
ONCHAINOS_WALLET_ADDRESS=...
```

### Use

```bash
# Find where smart money is active
npx hypernansen scan

# Check BTC sentiment
npx hypernansen sentiment BTC

# Who is long ETH right now?
npx hypernansen positions ETH --side Long

# Latest smart money opens
npx hypernansen new --limit 20

# Best trader to copy on SOL
npx hypernansen copy SOL

# Dry-run a trade (safe — no real order)
npx hypernansen trade -t BTC -s Long -z 100 -l 5

# Live trade (requires --live + confirmation)
npx hypernansen trade -t BTC -s Long -z 100 -l 5 --live
```

### Run as Agent Server

```bash
npm run agent:start
# Listening on http://localhost:3100

# Natural language
curl -X POST http://localhost:3100/chat \
  -H 'Content-Type: application/json' \
  -d '{"message": "what is smart money doing on BTC"}'

# Execute skill
curl -X POST http://localhost:3100/skills/hl_sentiment \
  -H 'Content-Type: application/json' \
  -d '{"token": "ETH"}'
```

---

## Typical Workflow

```bash
# 1. Scan — find the most active token
$ hypernansen scan
  BTC    +$12.4M  42 longs  11 shorts  LONG bias (79%)
  ETH    +$8.1M   31 longs  18 shorts  LONG bias (63%)
  SOL    -$3.2M   9 longs   28 shorts  SHORT bias (24%)

# 2. Confirm sentiment on top token
$ hypernansen sentiment BTC
  Signal:    >>> STRONG LONG (84% confidence)
  SM Longs:  42 wallets ($31.2M)
  SM Shorts: 11 wallets ($8.1M)
  L/S Ratio: 3.85x | Net: +$23.1M
  24h Flow:  Buy 76% / Sell 24%

# 3. Find best trader to copy
$ hypernansen copy BTC
  Source:    NansenFund_Alpha
  Direction: Long
  Leverage:  8x (capped from source)
  Trader PnL: +$180,420
  Dist to Liq: 22.4% — moderate risk
  → Run: hypernansen trade -t BTC -s Long -z 100 -l 8

# 4. Execute (dry run first, then --live)
$ hypernansen trade -t BTC -s Long -z 100 -l 8
  [DRY RUN] Long BTC $100 @ 8x
  Est. fee: $0.05
  → To submit: add --live flag
```

---

## Architecture

```
src/
├── nansen/
│   ├── hyperliquid-types.ts     # All Nansen HL type definitions
│   └── hyperliquid-client.ts    # NansenHyperliquidClient
│       ├── getSmartMoneyPerpTrades()    → /api/v1/smart-money/perp-trades
│       ├── screenPerps()               → /api/v1/perp-screener
│       ├── getTokenPerpPositions()     → /api/v1/tgm/perp-positions
│       ├── getAddressPerpPositions()   → /api/v1/profiler/perp-positions
│       ├── getSmartMoneySentiment()    → computed composite signal
│       └── getCopyTradeSetup()         → best trader by uPnL + safety
│
├── onchainos/
│   └── hyperliquid-client.ts    # OnchainOsHyperliquidClient
│       ├── placeOrder()         → POST /hyperliquid/order
│       ├── closePosition()      → POST /hyperliquid/close
│       ├── setLeverage()        → POST /hyperliquid/leverage
│       └── getAccountSummary()  → GET /hyperliquid/account
│
├── agent/
│   ├── hyperliquid-skills.ts    # 6 SkillDefinition objects
│   └── server.ts                # Express skill server + /chat NLP
│
├── cli/
│   ├── index.ts                 # Commander CLI entry
│   └── commands/
│       ├── hl-scan.ts           # scan command
│       ├── hl-sentiment.ts      # sentiment command
│       ├── hl-positions.ts      # positions command
│       ├── hl-new-positions.ts  # new command
│       ├── hl-copy.ts           # copy command
│       └── hl-trade.ts          # trade command (OnchainOS execution)
│
├── config/index.ts              # AppConfig + loadConfig()
└── utils/
    ├── formatting.ts            # formatUsd, formatPercent
    └── logger.ts                # Colored logger
```

---

## Smart Money Sentiment Algorithm

The `getSmartMoneySentiment()` method combines two data sources into a composite score:

1. **Positioning score** (60% weight): `smartMoneyLongUsd / (longUsd + shortUsd)`
2. **Flow score** (40% weight): `buyVolume / (buyVolume + sellVolume)` from 24h perp screener

```
compositeScore = longBias × 0.6 + flowBias × 0.4

≥ 0.72 → STRONG LONG
≥ 0.58 → LEAN LONG
≤ 0.28 → STRONG SHORT
≤ 0.42 → LEAN SHORT
else   → NEUTRAL
```

---

## Copy Trade Selection

The `getCopyTradeSetup()` method filters positions for:
- `upnl_usd > 0` — trader must be profitable
- `leverage ≤ 20` — excludes reckless leverage
- `dist_to_liq > 5%` — not near liquidation

Then selects the highest uPnL candidate and caps suggested leverage at 10x for safety.

---

## Safety Features

- **Dry run by default** — `trade` command never executes without `--live` flag
- **Leverage hard cap** — max 20x enforced in both CLI and agent
- **Trade size cap** — `MAX_TRADE_SIZE_USD` config limits agent auto-trade size
- **Confirmation prompt** — live trades require interactive confirmation
- **Mode gates** — agent only auto-trades in `AGENT_MODE=auto-trade`

---

## Nansen Hyperliquid Endpoints Used

| Endpoint | Used for |
|----------|----------|
| `POST /api/v1/smart-money/perp-trades` | New smart money opens |
| `POST /api/v1/perp-screener` | Token-level SM flows + OI + funding |
| `POST /api/v1/tgm/perp-positions` | Who is long/short a specific token |
| `POST /api/v1/profiler/perp-positions` | All positions for an address |

Smart Money labels filtered: `Fund`, `Smart HL Perps Trader`, `Smart Trader`

---

## OKX OnchainOS Integration

Uses the [Hyperliquid Plugin](https://web3.okx.com/onchainos/plugins/detail/hyperliquid) via OnchainOS Open API.

Authentication: HMAC-SHA256 signature — `${timestamp}${METHOD}${path}${body}` using `OK-ACCESS-KEY` / `OK-ACCESS-SIGN` / `OK-ACCESS-TIMESTAMP` headers.

---

## Tech Stack

- **TypeScript** with strict mode
- **Commander.js** — CLI framework
- **Nansen API** — Hyperliquid smart money data
- **OKX OnchainOS** — Hyperliquid perp execution
- **Express** — Agent skill HTTP server
- **axios** — HTTP client with interceptors
- **inquirer** — Interactive confirmation prompts
- **cli-table3 + chalk + ora** — CLI UX

## License

MIT
