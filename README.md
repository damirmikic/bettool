# BetTool

Bet comparison web app prototype inspired by OddsPortal and BetExplorer.

## Run the web app

```bash
npm start
```

Open `http://127.0.0.1:3000`.

## Run the CLI

```bash
npm run cli
```

## Turso admin setup

This project now includes a Turso-backed admin/configuration scaffold for:

- unmatched leagues
- unmatched events
- bookmaker mappings
- canonical leagues and teams

Setup guide:

- [docs/TURSO_SETUP.md](/c:/Users/kvoter2/Desktop/Projects/Betting/BetTool/docs/TURSO_SETUP.md)

After creating your Turso database and `.env`, run:

```bash
npm install
npm run db:check
npm run db:init
```

## Current scope

- Fetches Merkur XTip soccer offer from the provided REST endpoint.
- Fetches Pinnacle soccer leagues, then expands league odds for each league.
- Normalizes both feeds into a shared event structure.
- Compares common `1`, `X`, and `2` prices for matched events.
- Exposes a lightweight web UI with search, league filters, sorting, refresh, and arb highlighting.

## API

- `GET /api/comparisons`
- `POST /api/refresh`
- `GET /api/admin/status`
- `POST /api/admin/db-check`
- `POST /api/admin/db-init`

Supported query params for `/api/comparisons`:

- `search`
- `league`
- `sort=edge|start|arb`
- `limit=50|100|all`

## Notes

- Data is cached in memory for 60 seconds to keep the UI responsive.
- Event matching currently relies on normalized home/away team names.
- The Pinnacle event-level endpoint is still a good next step for deeper markets like totals and handicaps.
- Turso is intended for admin/configuration persistence, not for raw live-odds scraping itself.
