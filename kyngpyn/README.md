# KYNGPYN TRADE CONTROL SYSTEM™

Multi-Agent Trading Operating System — agents analyze, bots execute, learning
improves future decisions, and the system trades automatically only when
explicitly authorized. **No profits are guaranteed; markets carry real risk.**

Runs continuously as a Node.js service (VPS / Docker / PM2), with a live web
dashboard, three trading modes, and hard safety controls that nothing —
including the learning engine — can bypass.

```
Market Data ─▶ Scanner ─▶ Agent Council ─▶ Decision Engine ─▶ Execution Bots
     │                        │                  │                  │
     └── OANDA v20 /          └── 6 agents,      └── restrictions:  └── paper or live
         simulated feed           votes only         loss limits,       broker + SL/TP/
         (100+ instruments)                          news, sessions,    journal/alert bots
                                                     regime, DNT
                              Learning Engine ◀── closed trades (bounded influence)
```

## Quick start

Requires Node.js ≥ 18.17 (no npm dependencies at all).

```bash
cd kyngpyn
cp .env.example .env          # optional; defaults run out of the box
npm run start:sim             # simulation: full pipeline, NO trades placed
# open http://localhost:8420
```

Without OANDA credentials the system uses a built-in simulated price feed, so
every layer (scanner, council, decisions, dashboard, voice) works immediately.

```bash
npm run start:paper           # paper: virtual trades against the price feed
npm test                      # 40+ tests via node:test
```

## Trading modes

| Mode | Trades | Requirements |
|---|---|---|
| `simulation` | None — decisions are logged only | none |
| `paper` | Virtual fills, virtual $100k account | none (OANDA practice creds optional for real prices) |
| `live` | **Real OANDA orders** | `OANDA_API_KEY`, `OANDA_ACCOUNT_ID`, `LIVE_TRADING_ENABLED=true`, **and** `LIVE_CONFIRMATION="I UNDERSTAND LIVE TRADING RISKS"` |

Live mode refuses to boot unless all four are present. Do not enable live
until earlier phases have been run and validated (see Development Phases).

## The layers

1. **Market Data Engine** (`src/data/`) — OANDA v20 REST + streaming with
   heartbeat-watchdog reconnects and exponential backoff, TTL candle cache,
   112 instruments defined (forex majors/minors/exotics, metals, indices,
   crypto). Falls back to a simulated random-walk feed with zero config.
2. **Multi-Symbol Scanner** (`src/scanner/`) — continuous loop (default 15s)
   scoring trend, momentum, RSI, liquidity sweeps, session context and market
   regime per symbol. Output: `{ "symbol": "EUR_USD", "direction": "LONG",
   "confidence": 78 }`.
3. **Agent Council** (`src/agents/`) — Market, Liquidity, Risk, News,
   Portfolio, and Learning agents each return `{ agent, vote, score, reason }`.
   Agents never place trades; a crashing agent counts as REJECT.
4. **Decision Engine** (`src/decision/`) — averages scores, blends scanner
   confidence, applies **hard restrictions**: daily loss limit, news windows,
   Do-Not-Trade list, session restrictions, volatile-regime block, plus
   Risk/News agent veto power. Output: `{ "approved": true, "confidence": 79 }`.
5. **Execution Bot Layer** (`src/execution/`) — Execution Bot (the only
   component that opens trades, strictly on `approved === true`, with a
   safety re-check at fill time), Position Manager, Stop Loss (breakeven +
   ATR trailing), Take Profit, Journal (append-only `data/journal.jsonl`
   audit trail), and Alert bots.
6. **Learning Engine** (`src/learning/`) — records symbol/session/setup/
   result/regime for every closed trade; adjusts confidence (clamped to
   ±`LEARNING_MAX_ADJUSTMENT`) and position sizing (clamped to 0.5×–1.25×).
   **Learning can modify scores; it can never bypass risk controls.**
7. **Trading Modes** — see table above; kill switch and human override in all.
8. **Dashboard** (`public/index.html`) — agent votes, scanner table, regime,
   open positions, performance, journal, health, alerts, kill switch, pause,
   and the Doris voice button. Live updates over SSE.

## Safety controls

- Daily max loss (`DAILY_MAX_LOSS_PCT`, default 3%) — trips and halts entries.
- Consecutive-loss cutoff (`MAX_CONSECUTIVE_LOSSES`, default 4).
- Position limits (total and per symbol).
- **Kill switch** — halts trading and flattens all positions
  (dashboard button, `POST /api/command {"action":"kill_switch"}`, or
  "Doris emergency stop").
- Manual pause/resume and human override (`override_safety` resets counters —
  a deliberate human action, never automatic).
- Safety state persists to disk; a restart cannot reset a tripped limit.

## API

| Route | Purpose |
|---|---|
| `GET /` | Dashboard |
| `GET /api/state` | Full system snapshot |
| `GET /api/health` | Health check (503 when degraded) |
| `GET /api/journal`, `/api/logs`, `/api/learning`, `/api/news` | Audit & data |
| `POST /api/command` | `{action, args}`: `scan`, `pause`, `resume`, `kill_switch`, `release_kill_switch`, `close_all`, `close_symbol`, `execute_setup`, `dnt_add`, `dnt_remove`, `override_safety`, `status` |
| `POST /api/command/voice` | `{transcript}` — Doris commands |
| `POST /api/news` | Add a calendar event `{time, currency, impact, title}` |
| `GET /events` | SSE stream (alerts, decisions, trades) |

## Voice ("Doris")

The dashboard mic button uses the Web Speech API; commands also work as text
via `POST /api/command/voice`. Examples: "Doris scan markets", "Doris execute
gold setup", "Doris stop trading", "Doris emergency stop", "Doris close all
positions", "Doris status". Voice-initiated setups still pass through the
full council + decision engine + safety pipeline — voice cannot bypass controls.

## Alerts

- **Browser** notifications + toasts (SSE).
- **Webhook**: `ALERT_WEBHOOK_URL` receives every alert as JSON.
- **SMS**: `ALERT_SMS_WEBHOOK_URL` (e.g. a Twilio function) gets critical alerts.
- **Email**: `ALERT_SMTP_URL` (smtps://user:pass@host:465) + `ALERT_EMAIL_TO`
  for critical/error alerts.

## Deployment

**PM2 (VPS):**
```bash
npm install -g pm2
pm2 start ecosystem.config.cjs          # simulation
pm2 start ecosystem.config.cjs --env paper
pm2 save && pm2 startup                 # survive reboots
```

**Docker:**
```bash
docker compose up -d --build            # state persists in the kyngpyn-data volume
```

The backend runs continuously regardless of whether a browser is open.

## Development phases

1. **Data + Scanner** — run `simulation`, watch scanner output. ✅ built
2. **Agent Council** — verify votes/decisions in the dashboard. ✅ built
3. **Paper Trading** — run `paper` for an extended period. ✅ built
4. **Learning Engine** — accumulates once paper trades close. ✅ built
5. **Live Execution** — only after 1–4 are validated; requires explicit flags. ✅ built, gated
6. **Voice + Notifications** — ✅ built

**No live trading should be enabled until earlier phases have been tested and
validated with your own account and risk settings.** This system is a
reliability-focused trading OS, not a profit guarantee.
