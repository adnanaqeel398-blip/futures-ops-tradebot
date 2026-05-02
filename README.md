# FuturesOps TradeBot

Binance Futures/Spot copy-trading bot with signal generation, trade execution, PnL tracking, and a real-time dashboard.

## Features

- **Signal Generation** — Technical analysis (SMA, RSI, Bollinger Bands, ATR, volume) with auto-generated BUY/SELL signals
- **Signal Approval Flow** — Signals go through pending → approved → executed pipeline
- **Trade Execution** — Futures & Spot market orders on Binance with TP/SL
- **Copy Trading** — Master trades automatically copied to client accounts with proportional sizing
- **PnL Tracking** — Real-time PnL with 30% profit sharing to master account
- **Trade Monitoring** — Live monitor score, auto-close on SL/TP hit
- **Webhook Support** — Accept signals from TradingView or external sources
- **Dashboard** — Full-featured web UI with signal panel, trade execution, monitoring, and logs
- **Auth System** — JWT-based authentication with AES-256-GCM encrypted API key storage

## Quick Start

```bash
cp .env.example .env    # Edit with your keys
npm install
npm start               # http://localhost:8787
```

## API Endpoints

### Public
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/status` | Full status with stats |
| GET | `/api/futures/symbols` | Binance futures symbols |
| GET | `/api/spot/symbols` | Binance spot symbols |
| GET | `/api/futures/klines` | Futures klines |
| GET | `/api/spot/klines` | Spot klines |

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Register user |
| POST | `/api/auth/login` | Login |

### Signals
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/signals` | List all signals |
| GET | `/api/approved-signals` | List approved signals |
| POST | `/api/signals/generate` | Generate new signal |
| POST | `/api/signals/:id/approve` | Approve signal |
| POST | `/api/signals/:id/reject` | Reject signal |

### Trades
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/trades` | List all trades |
| POST | `/api/trades/execute` | Execute approved signal |
| POST | `/api/trades/:id/monitor` | Monitor trade (refresh PnL) |
| POST | `/api/trades/:id/close` | Close trade |
| POST | `/api/trade/executeFutures` | Direct futures trade (auth) |
| POST | `/api/trade/executeSpot` | Direct spot trade (auth) |
| POST | `/api/trade/masterTrade` | Master copy trade |

### Clients (Copy Trading)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/clients` | List clients |
| POST | `/api/clients/add` | Add client |
| POST | `/api/clients/:id/toggle` | Toggle client |
| DELETE | `/api/clients/:id` | Remove client |

### Other
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/settings/save` | Save settings |
| GET | `/api/settings` | Get settings |
| POST | `/api/webhook` | External webhook |
| POST | `/api/pnl/close` | Close all trades for symbol |
| GET | `/api/master/summary` | Master account summary |
| GET | `/api/logs` | Activity logs |

## Live Deployment

The bot is deployed on Railway and accessible globally:

**Dashboard:** https://futures-ops-tradebot-production.up.railway.app

### Blogspot Integration

To embed on https://alphaprotrader.blogspot.com/:
1. Go to Blogger → Pages → New Page (or edit existing)
2. Switch to **HTML view**
3. Paste the code from `BLOGSPOT_EMBED.html`
4. Publish

## Environment Variables

See `.env.example` for all configuration options.
