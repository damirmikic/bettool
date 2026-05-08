# Turso Setup Guide

This guide sets up Turso for the BetTool admin/configuration layer:

- canonical league mappings
- canonical team mappings
- unmatched leagues
- unmatched events
- review decisions

## 1. Install the Turso CLI

Use the official Turso CLI install instructions, then authenticate:

```bash
turso auth login
```

Official docs:

- CLI authentication: https://docs.turso.tech/cli/authentication

## 2. Create a database group

Turso databases are created inside a group.

```bash
turso group create bettool --location fra
```

If you want Turso to choose automatically, omit `--location`.

Official docs:

- Group create: https://docs.turso.tech/cli/group/create

## 3. Create the database

Create a dedicated admin/configuration database:

```bash
turso db create bettool-admin --group bettool
```

If your CLI version does not expose `turso db create`, create the database through the API or the Turso dashboard. The official API requires a database `name` and `group`.

Official docs:

- Create database API: https://docs.turso.tech/api-reference/databases/create

## 4. Get the database URL

Fetch the `libsql://...` database URL:

```bash
turso db show --url bettool-admin
```

Official docs:

- `db show --url`: https://docs.turso.tech/cli/db/show
- SDK authentication: https://docs.turso.tech/sdk/authentication

## 5. Create an auth token

Generate a token for the database:

```bash
turso db tokens create bettool-admin
```

For production, use an expiration period instead of a never-ending token:

```bash
turso db tokens create bettool-admin --expiration 30d
```

Official docs:

- `db tokens create`: https://docs.turso.tech/cli/db/tokens/create

## 6. Add environment variables

Copy `.env.example` to `.env` and fill in the values:

```env
TURSO_DATABASE_URL=libsql://your-database-your-org.turso.io
TURSO_AUTH_TOKEN=your-token
```

The JavaScript libSQL client uses these values to connect.

Official docs:

- JS/TS quickstart: https://docs.turso.tech/sdk/ts

## 7. Install dependencies

Install project dependencies:

```bash
npm install
```

This project uses `@libsql/client` for Turso connectivity.

Official docs:

- JS/TS quickstart: https://docs.turso.tech/sdk/ts

## 8. Initialize the admin schema

Run:

```bash
npm run db:init
```

This creates the admin tables used for mappings and review workflows.

You can test connectivity with:

```bash
npm run db:check
```

## 9. What gets created

The admin schema includes:

- `admin_bookmakers`
- `admin_canonical_countries`
- `admin_canonical_leagues`
- `admin_canonical_teams`
- `admin_league_mappings`
- `admin_team_mappings`
- `admin_unmatched_leagues`
- `admin_unmatched_events`
- `admin_match_decisions`

## 10. Recommended production approach

- Use Turso for admin/configuration and persistent mapping data.
- Keep live odds fetching separate from admin writes.
- Write unmatched leagues/events into Turso during ingest.
- Resolve them in an admin UI and reuse those mappings in future runs.

## 11. Troubleshooting

If `npm run db:check` fails:

1. Verify `TURSO_DATABASE_URL`
2. Verify `TURSO_AUTH_TOKEN`
3. Make sure the token is for the same database
4. Regenerate the token if needed

You can rotate/replace tokens from the Turso side if necessary:

- Token rotation docs: https://docs.turso.tech/api-reference/databases/invalidate-tokens
