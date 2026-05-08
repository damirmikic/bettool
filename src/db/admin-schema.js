export const ADMIN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS admin_bookmakers (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS admin_canonical_countries (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS admin_canonical_leagues (
  id INTEGER PRIMARY KEY,
  canonical_country_id INTEGER REFERENCES admin_canonical_countries(id),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS admin_canonical_teams (
  id INTEGER PRIMARY KEY,
  canonical_country_id INTEGER REFERENCES admin_canonical_countries(id),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS admin_league_mappings (
  id INTEGER PRIMARY KEY,
  bookmaker_id INTEGER NOT NULL REFERENCES admin_bookmakers(id),
  source_country_name TEXT,
  source_league_name TEXT NOT NULL,
  canonical_league_id INTEGER NOT NULL REFERENCES admin_canonical_leagues(id),
  confidence REAL NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(bookmaker_id, source_country_name, source_league_name)
) STRICT;

CREATE TABLE IF NOT EXISTS admin_team_mappings (
  id INTEGER PRIMARY KEY,
  bookmaker_id INTEGER NOT NULL REFERENCES admin_bookmakers(id),
  source_team_name TEXT NOT NULL,
  canonical_team_id INTEGER NOT NULL REFERENCES admin_canonical_teams(id),
  confidence REAL NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(bookmaker_id, source_team_name)
) STRICT;

CREATE TABLE IF NOT EXISTS admin_unmatched_leagues (
  id INTEGER PRIMARY KEY,
  bookmaker_slug TEXT NOT NULL,
  source_country_name TEXT,
  source_league_name TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  seen_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open', 'mapped', 'ignored')),
  notes TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS admin_unmatched_leagues_unique_open
  ON admin_unmatched_leagues(bookmaker_slug, source_country_name, source_league_name);

CREATE TABLE IF NOT EXISTS admin_unmatched_events (
  id INTEGER PRIMARY KEY,
  bookmaker_slug TEXT NOT NULL,
  source_event_id TEXT,
  source_country_name TEXT,
  source_league_name TEXT,
  source_home_name TEXT NOT NULL,
  source_away_name TEXT NOT NULL,
  source_start_time TEXT,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  seen_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open', 'matched', 'ignored')),
  notes TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS admin_unmatched_events_unique_open
  ON admin_unmatched_events(
    bookmaker_slug,
    source_event_id,
    source_home_name,
    source_away_name,
    source_start_time
  );

CREATE TABLE IF NOT EXISTS admin_match_decisions (
  id INTEGER PRIMARY KEY,
  unmatched_event_id INTEGER REFERENCES admin_unmatched_events(id),
  decision_type TEXT NOT NULL
    CHECK(decision_type IN ('match_existing', 'create_alias', 'ignore')),
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
`;
