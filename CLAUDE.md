# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                   # Start the web server on port 3000
npm run cli                 # Run the CLI comparison view
npm run cli -- --limit=N    # CLI with custom row limit (N or "all")
npm run db:init             # Initialize Turso admin schema (run once after setup)
npm run db:check            # Test Turso connectivity
```

The server listens on `127.0.0.1:3000` by default. Set `PORT` env var to override.

## Environment variables

Copy `.env.example` to `.env` before running. The admin/Turso layer is optional — the app runs without it but won't persist unmatched review data or apply custom mappings.

```
TURSO_DATABASE_URL=libsql://your-database-your-org.turso.io
TURSO_AUTH_TOKEN=your-turso-auth-token
```

## Architecture

BetTool fetches live 1X2 soccer odds from **Merkur XTip** and **Pinnacle**, normalizes team names to a common key, matches events between the two, and flags arbitrage opportunities. An optional Turso-backed admin layer lets operators manage canonical league/team mappings and review unmatched events.

### Data pipeline

```
providers/merkur.js  ─┐
                       ├─► compare.js ─► comparison-service.js ─► server.js / cli.js
providers/pinnacle.js ─┘
         ↑                        ↑
  admin-repository.js      admin-repository.js
  (apply mappings)         (save unmatched data)
```

1. **Providers** (`src/providers/`) fetch raw odds and emit a flat array of `{ key: {home, away}, markets: { moneyline: {home, draw, away} }, country, league, startTime, ... }` objects. Pinnacle fetches progressively — one batch of 50 leagues at a time with a 250 ms delay between requests; Merkur is a single bulk request.

2. **Admin mappings** (`src/db/admin-repository.js → loadAdminMappings()`) are loaded from Turso at refresh time and applied via `applyAdminMappings()` in the comparison service. League and team names from each bookmaker are remapped to canonical names before event matching occurs.

3. **Normalize** (`src/lib/normalize.js`) converts team names to a canonical key: lowercase → NFKD decomposition → strip accents/non-alphanumeric → remove soccer stop words (`fc`, `fk`, `cf`, `sc`, `ac`, `club`, `football`, `fudbal`, `team`). `normalizeEventKey` produces `"normalized_home::normalized_away"` for join keys.

4. **Compare** (`src/lib/compare.js`) joins events on normalized key, computes per-outcome best price, price delta, and arbitrage margin (`1 / Σ(1/bestOdds)` — values below 1.0 are arbs).

5. **Comparison service** (`src/services/comparison-service.js`) orchestrates the full refresh:
   - Fetches Merkur and admin mappings in parallel.
   - Streams Pinnacle batches; each completed batch updates the in-memory cache and writes a disk snapshot to `data/cache/comparisons.json`.
   - On a cold start with no cache, serves the first available Pinnacle batch immediately via a deferred promise (`cache.firstReady`).
   - Implements stale-while-revalidate: serves the last good snapshot and triggers a background refresh if the 60-second TTL has expired.
   - After a complete refresh, saves all unmatched leagues and events to Turso for admin review.

6. **Server** (`src/server.js`) exposes REST routes and serves static files from `public/`. Routes:
   - `GET /api/comparisons` — query params: `search`, `country`, `league`, `sort` (`edge`|`start`|`arb`), `limit` (`50`|`100`|`all`)
   - `POST /api/refresh` — bypass cache and force a full refresh
   - `GET /api/admin/status` — Turso config health check
   - `POST /api/admin/db-check` — test DB connectivity
   - `POST /api/admin/db-init` — run schema migrations
   - `GET /api/admin/review` — list unmatched leagues/events with fuzzy-match suggestions
   - `GET /api/admin/mappings` — list all active league/team mappings
   - `POST /api/admin/league-mappings` / `POST /api/admin/team-mappings` — create mappings manually
   - `POST /api/admin/unmatched-leagues/:id/map` / `.../ignore`
   - `POST /api/admin/unmatched-events/:id/map` / `.../ignore`
   - `POST /api/admin/league-mappings/:id/unmap` / `team-mappings/:id/unmap`

### Admin/Turso layer

The Turso database (`src/db/`) stores configuration that persists across restarts. Schema (`src/db/admin-schema.js`):

- `admin_bookmakers` — seeded with `merkurxtip` and `pinnacle` slugs
- `admin_canonical_countries / leagues / teams` — the authoritative name registry
- `admin_league_mappings / admin_team_mappings` — bookmaker source name → canonical name
- `admin_unmatched_leagues / admin_unmatched_events` — items seen but not yet mapped (status: `open`|`mapped`|`ignored`)
- `admin_match_decisions` — audit log for event match actions

`admin-repository.js` contains the fuzzy-match suggestion logic (`similarityScore` using token Jaccard + substring bonus, threshold 0.35) used to pre-fill the admin review UI.

The admin UI is at `public/admin.html` + `public/admin.js`. The main odds UI is `public/index.html` + `public/app.js`.

### Module system

The project uses **ES modules** (`"type": "module"` in package.json). All imports use `.js` extensions explicitly.

### No external framework

The HTTP server uses Node's native `http` module. `src/lib/http.js` wraps `fetch` with retry logic for 429 responses. `src/lib/load-env.js` loads `.env` without external dotenv packages.
