import { ADMIN_SCHEMA_SQL } from "./admin-schema.js";
import { createTursoClient, isTursoConfigured } from "./turso.js";
import { normalizeTeamName } from "../lib/normalize.js";
import { cleanDisplayText } from "../lib/normalize.js";

const DEFAULT_ADMIN_REVIEW_LIMIT = 150;
const DEFAULT_ADMIN_MAPPING_OPTION_LIMIT = 250;
const DEFAULT_ADMIN_MAPPED_LIST_LIMIT = 250;

function splitStatements(sql) {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function initializeAdminSchema() {
  const client = await createTursoClient();

  for (const statement of splitStatements(ADMIN_SCHEMA_SQL)) {
    await client.execute(statement);
  }

  await seedBookmakers(client);

  return {
    ok: true,
    statementsExecuted: splitStatements(ADMIN_SCHEMA_SQL).length,
  };
}

async function seedBookmakers(client) {
  await client.batch([
    {
      sql: `
        INSERT INTO admin_bookmakers (slug, display_name)
        VALUES (?, ?)
        ON CONFLICT(slug) DO UPDATE SET display_name = excluded.display_name
      `,
      args: ["merkurxtip", "MerkurXTip"],
    },
    {
      sql: `
        INSERT INTO admin_bookmakers (slug, display_name)
        VALUES (?, ?)
        ON CONFLICT(slug) DO UPDATE SET display_name = excluded.display_name
      `,
      args: ["pinnacle", "Pinnacle"],
    },
  ]);
}

export async function checkAdminDatabase() {
  const client = await createTursoClient();
  const result = await client.execute("SELECT 1 AS ok");
  return {
    ok: true,
    rowCount: result.rows.length,
  };
}

async function getClientIfConfigured() {
  if (!isTursoConfigured()) {
    return null;
  }

  return createTursoClient();
}

async function getBookmakerId(client, slug) {
  const result = await client.execute({
    sql: "SELECT id FROM admin_bookmakers WHERE slug = ?",
    args: [slug],
  });

  return result.rows[0]?.id ?? null;
}

async function getOrCreateCountry(client, countryName) {
  const existing = await client.execute({
    sql: "SELECT id FROM admin_canonical_countries WHERE name = ?",
    args: [countryName],
  });

  if (existing.rows[0]?.id) {
    return existing.rows[0].id;
  }

  await client.execute({
    sql: "INSERT INTO admin_canonical_countries (slug, name) VALUES (?, ?)",
    args: [createSlug(countryName), countryName],
  });

  const inserted = await client.execute({
    sql: "SELECT id FROM admin_canonical_countries WHERE name = ?",
    args: [countryName],
  });

  return inserted.rows[0]?.id ?? null;
}

async function getOrCreateLeague(client, canonicalCountryId, leagueName) {
  const existing = await client.execute({
    sql: `
      SELECT id
      FROM admin_canonical_leagues
      WHERE name = ? AND canonical_country_id IS ?
    `,
    args: [leagueName, canonicalCountryId],
  });

  if (existing.rows[0]?.id) {
    return existing.rows[0].id;
  }

  await client.execute({
    sql: `
      INSERT INTO admin_canonical_leagues (canonical_country_id, slug, name)
      VALUES (?, ?, ?)
    `,
    args: [canonicalCountryId, createSlug(`${leagueName}-${canonicalCountryId ?? "none"}`), leagueName],
  });

  const inserted = await client.execute({
    sql: `
      SELECT id
      FROM admin_canonical_leagues
      WHERE name = ? AND canonical_country_id IS ?
    `,
    args: [leagueName, canonicalCountryId],
  });

  return inserted.rows[0]?.id ?? null;
}

async function getOrCreateTeam(client, canonicalCountryId, teamName) {
  const existing = await client.execute({
    sql: `
      SELECT id
      FROM admin_canonical_teams
      WHERE name = ? AND canonical_country_id IS ?
    `,
    args: [teamName, canonicalCountryId],
  });

  if (existing.rows[0]?.id) {
    return existing.rows[0].id;
  }

  await client.execute({
    sql: `
      INSERT INTO admin_canonical_teams (canonical_country_id, slug, name)
      VALUES (?, ?, ?)
    `,
    args: [canonicalCountryId, createSlug(`${teamName}-${canonicalCountryId ?? "none"}`), teamName],
  });

  const inserted = await client.execute({
    sql: `
      SELECT id
      FROM admin_canonical_teams
      WHERE name = ? AND canonical_country_id IS ?
    `,
    args: [teamName, canonicalCountryId],
  });

  return inserted.rows[0]?.id ?? null;
}

function createSlug(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function similarityScore(left, right) {
  const a = normalizeTeamName(left);
  const b = normalizeTeamName(right);

  if (!a || !b) {
    return 0;
  }

  if (a === b) {
    return 1;
  }

  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  const union = new Set([...aTokens, ...bTokens]);
  let intersection = 0;

  for (const token of aTokens) {
    if (bTokens.has(token)) {
      intersection += 1;
    }
  }

  const tokenScore = union.size > 0 ? intersection / union.size : 0;
  const substringBonus = a.includes(b) || b.includes(a) ? 0.15 : 0;

  return Math.min(1, Number((tokenScore + substringBonus).toFixed(3)));
}

function scoreCountryMatch(sourceCountry, canonicalCountry) {
  if (!sourceCountry || !canonicalCountry) {
    return 0;
  }

  return normalizeTeamName(sourceCountry) === normalizeTeamName(canonicalCountry) ? 0.2 : 0;
}

function pickBestLeagueSuggestion(unmatchedLeague, canonicalLeagues) {
  let best = null;

  for (const league of canonicalLeagues) {
    const baseScore = similarityScore(
      unmatchedLeague.source_league_name,
      league.canonical_league_name,
    );
    const countryBoost = scoreCountryMatch(
      unmatchedLeague.source_country_name,
      league.canonical_country_name,
    );
    const confidence = Math.min(1, Number((baseScore + countryBoost).toFixed(3)));

    if (!best || confidence > best.confidence) {
      best = {
        canonicalCountryName: league.canonical_country_name ?? unmatchedLeague.source_country_name ?? "",
        canonicalLeagueName: league.canonical_league_name,
        confidence,
      };
    }
  }

  return best && best.confidence >= 0.35 ? best : null;
}

function pickBestCrossMatch(league, allLeagues) {
  let best = null;

  for (const other of allLeagues) {
    if (other.bookmaker_slug === league.bookmaker_slug) continue;

    const baseScore = similarityScore(league.source_league_name, other.source_league_name);
    const countryBoost = scoreCountryMatch(league.source_country_name, other.source_country_name);
    const confidence = Math.min(1, Number((baseScore + countryBoost).toFixed(3)));

    if (!best || confidence > best.confidence) {
      best = {
        bookmakerSlug: other.bookmaker_slug,
        sourceCountryName: other.source_country_name ?? null,
        sourceLeagueName: other.source_league_name,
        confidence,
      };
    }
  }

  return best && best.confidence >= 0.35 ? best : null;
}

function pickBestTeamSuggestion(unmatchedTeamName, sourceCountryName, canonicalTeams) {
  let best = null;

  for (const team of canonicalTeams) {
    const baseScore = similarityScore(unmatchedTeamName, team.canonical_team_name);
    const countryBoost = scoreCountryMatch(sourceCountryName, team.canonical_country_name);
    const confidence = Math.min(1, Number((baseScore + countryBoost).toFixed(3)));

    if (!best || confidence > best.confidence) {
      best = {
        canonicalCountryName: team.canonical_country_name ?? sourceCountryName ?? "",
        canonicalTeamName: team.canonical_team_name,
        confidence,
      };
    }
  }

  return best && best.confidence >= 0.35 ? best : null;
}

export async function loadAdminMappings() {
  const client = await getClientIfConfigured();

  if (!client) {
    return {
      leagueMappings: [],
      teamMappings: [],
    };
  }

  const [leagueMappings, teamMappings] = await Promise.all([
    client.execute(`
      SELECT
        b.slug AS bookmaker_slug,
        lm.source_country_name,
        lm.source_league_name,
        cc.name AS canonical_country_name,
        cl.name AS canonical_league_name
      FROM admin_league_mappings lm
      JOIN admin_bookmakers b ON b.id = lm.bookmaker_id
      JOIN admin_canonical_leagues cl ON cl.id = lm.canonical_league_id
      LEFT JOIN admin_canonical_countries cc ON cc.id = cl.canonical_country_id
      WHERE lm.is_active = 1
    `),
    client.execute(`
      SELECT
        b.slug AS bookmaker_slug,
        tm.source_team_name,
        cc.name AS canonical_country_name,
        ct.name AS canonical_team_name
      FROM admin_team_mappings tm
      JOIN admin_bookmakers b ON b.id = tm.bookmaker_id
      JOIN admin_canonical_teams ct ON ct.id = tm.canonical_team_id
      LEFT JOIN admin_canonical_countries cc ON cc.id = ct.canonical_country_id
      WHERE tm.is_active = 1
    `),
  ]);

  return {
    leagueMappings: leagueMappings.rows,
    teamMappings: teamMappings.rows,
  };
}

export async function saveUnmatchedReviewData({ unmatchedLeagues, unmatchedEvents }) {
  const client = await getClientIfConfigured();

  if (!client) {
    return {
      ok: false,
      skipped: true,
    };
  }

  for (const league of unmatchedLeagues) {
    const existing = await client.execute({
      sql: `
        SELECT id
        FROM admin_unmatched_leagues
        WHERE bookmaker_slug = ?
          AND COALESCE(source_country_name, '') = COALESCE(?, '')
          AND source_league_name = ?
      `,
      args: [league.bookmakerSlug, league.country ?? null, league.league ?? "Unknown league"],
    });

    if (existing.rows[0]?.id) {
      await client.execute({
        sql: `
          UPDATE admin_unmatched_leagues
          SET
            last_seen_at = CURRENT_TIMESTAMP,
            seen_count = seen_count + 1,
            status = CASE
              WHEN status = 'ignored' THEN 'ignored'
              ELSE 'open'
            END
          WHERE id = ?
        `,
        args: [existing.rows[0].id],
      });
    } else {
      await client.execute({
        sql: `
          INSERT INTO admin_unmatched_leagues (
            bookmaker_slug,
            source_country_name,
            source_league_name,
            first_seen_at,
            last_seen_at,
            seen_count,
            status
          )
          VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 'open')
        `,
        args: [league.bookmakerSlug, league.country ?? null, league.league ?? "Unknown league"],
      });
    }
  }

  for (const event of unmatchedEvents) {
    const startTimeIso = event.startTime ? new Date(event.startTime).toISOString() : null;
    const existing = await client.execute({
      sql: `
        SELECT id
        FROM admin_unmatched_events
        WHERE bookmaker_slug = ?
          AND COALESCE(source_event_id, '') = COALESCE(?, '')
          AND source_home_name = ?
          AND source_away_name = ?
          AND COALESCE(source_start_time, '') = COALESCE(?, '')
      `,
      args: [
        event.bookmakerSlug,
        event.eventId ?? null,
        event.home,
        event.away,
        startTimeIso,
      ],
    });

    if (existing.rows[0]?.id) {
      await client.execute({
        sql: `
          UPDATE admin_unmatched_events
          SET
            last_seen_at = CURRENT_TIMESTAMP,
            seen_count = seen_count + 1,
            status = CASE
              WHEN status = 'ignored' THEN 'ignored'
              ELSE 'open'
            END
          WHERE id = ?
        `,
        args: [existing.rows[0].id],
      });
    } else {
      await client.execute({
        sql: `
          INSERT INTO admin_unmatched_events (
            bookmaker_slug,
            source_event_id,
            source_country_name,
            source_league_name,
            source_home_name,
            source_away_name,
            source_start_time,
            first_seen_at,
            last_seen_at,
            seen_count,
            status
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 'open')
        `,
        args: [
          event.bookmakerSlug,
          event.eventId ?? null,
          event.country ?? null,
          event.league ?? null,
          event.home,
          event.away,
          startTimeIso,
        ],
      });
    }
  }

  return {
    ok: true,
    unmatchedLeagueCount: unmatchedLeagues.length,
    unmatchedEventCount: unmatchedEvents.length,
  };
}

async function upsertLeagueMapping({
  client,
  bookmakerId,
  sourceCountryName,
  sourceLeagueName,
  canonicalLeagueId,
}) {
  const existing = await client.execute({
    sql: `
      SELECT id
      FROM admin_league_mappings
      WHERE bookmaker_id = ?
        AND COALESCE(source_country_name, '') = COALESCE(?, '')
        AND source_league_name = ?
    `,
    args: [bookmakerId, sourceCountryName ?? null, sourceLeagueName],
  });

  if (existing.rows[0]?.id) {
    await client.execute({
      sql: `
        UPDATE admin_league_mappings
        SET
          canonical_league_id = ?,
          confidence = 1,
          is_active = 1
        WHERE id = ?
      `,
      args: [canonicalLeagueId, existing.rows[0].id],
    });
    return;
  }

  await client.execute({
    sql: `
      INSERT INTO admin_league_mappings (
        bookmaker_id,
        source_country_name,
        source_league_name,
        canonical_league_id,
        confidence,
        is_active
      )
      VALUES (?, ?, ?, ?, 1, 1)
    `,
    args: [bookmakerId, sourceCountryName ?? null, sourceLeagueName, canonicalLeagueId],
  });
}

async function upsertTeamMapping({
  client,
  bookmakerId,
  sourceTeamName,
  canonicalTeamId,
}) {
  const existing = await client.execute({
    sql: `
      SELECT id
      FROM admin_team_mappings
      WHERE bookmaker_id = ?
        AND source_team_name = ?
    `,
    args: [bookmakerId, sourceTeamName],
  });

  if (existing.rows[0]?.id) {
    await client.execute({
      sql: `
        UPDATE admin_team_mappings
        SET
          canonical_team_id = ?,
          confidence = 1,
          is_active = 1
        WHERE id = ?
      `,
      args: [canonicalTeamId, existing.rows[0].id],
    });
    return;
  }

  await client.execute({
    sql: `
      INSERT INTO admin_team_mappings (
        bookmaker_id,
        source_team_name,
        canonical_team_id,
        confidence,
        is_active
      )
      VALUES (?, ?, ?, 1, 1)
    `,
    args: [bookmakerId, sourceTeamName, canonicalTeamId],
  });
}

export async function listAdminReviewData({ limit = DEFAULT_ADMIN_REVIEW_LIMIT } = {}) {
  const client = await getClientIfConfigured();

  if (!client) {
    return {
      unmatchedLeagues: [],
      unmatchedEvents: [],
    };
  }

  const [unmatchedLeagues, unmatchedEvents, canonicalLeagues, canonicalTeams] = await Promise.all([
    client.execute({
      sql: `
      SELECT
        id,
        bookmaker_slug,
        source_country_name,
        source_league_name,
        first_seen_at,
        last_seen_at,
        seen_count,
        status,
        notes
      FROM admin_unmatched_leagues
      WHERE status = 'open'
      ORDER BY last_seen_at DESC, seen_count DESC
      LIMIT ?
    `,
      args: [limit],
    }),
    client.execute({
      sql: `
      SELECT
        id,
        bookmaker_slug,
        source_country_name,
        source_league_name,
        source_home_name,
        source_away_name,
        source_start_time,
        first_seen_at,
        last_seen_at,
        seen_count,
        status,
        notes
      FROM admin_unmatched_events
      WHERE status = 'open'
      ORDER BY last_seen_at DESC, seen_count DESC
      LIMIT ?
    `,
      args: [limit],
    }),
    client.execute(`
      SELECT
        cl.id,
        cl.name AS canonical_league_name,
        cc.name AS canonical_country_name
      FROM admin_canonical_leagues cl
      LEFT JOIN admin_canonical_countries cc ON cc.id = cl.canonical_country_id
      ORDER BY cl.name ASC
    `),
    client.execute(`
      SELECT
        ct.id,
        ct.name AS canonical_team_name,
        cc.name AS canonical_country_name
      FROM admin_canonical_teams ct
      LEFT JOIN admin_canonical_countries cc ON cc.id = ct.canonical_country_id
      ORDER BY ct.name ASC
    `),
  ]);

  const allOpenLeagues = unmatchedLeagues.rows;

  return {
    unmatchedLeagues: allOpenLeagues.map((row) => ({
      ...row,
      suggestion: pickBestLeagueSuggestion(row, canonicalLeagues.rows),
      crossMatch: pickBestCrossMatch(row, allOpenLeagues),
    })),
    unmatchedEvents: unmatchedEvents.rows.map((row) => ({
      ...row,
      suggestion: {
        home: pickBestTeamSuggestion(
          row.source_home_name,
          row.source_country_name,
          canonicalTeams.rows,
        ),
        away: pickBestTeamSuggestion(
          row.source_away_name,
          row.source_country_name,
          canonicalTeams.rows,
        ),
      },
    })),
  };
}

export async function mapUnmatchedLeague({
  unmatchedLeagueId,
  canonicalCountryName,
  canonicalLeagueName,
}) {
  const client = await createTursoClient();
  const unmatched = await client.execute({
    sql: `
      SELECT id, bookmaker_slug, source_country_name, source_league_name
      FROM admin_unmatched_leagues
      WHERE id = ?
    `,
    args: [unmatchedLeagueId],
  });

  const row = unmatched.rows[0];

  if (!row) {
    throw new Error("Unmatched league not found.");
  }

  const bookmakerId = await getBookmakerId(client, row.bookmaker_slug);
  const countryId = canonicalCountryName
    ? await getOrCreateCountry(client, canonicalCountryName)
    : null;
  const leagueId = await getOrCreateLeague(client, countryId, canonicalLeagueName);

  await upsertLeagueMapping({
    client,
    bookmakerId,
    sourceCountryName: row.source_country_name ?? null,
    sourceLeagueName: row.source_league_name,
    canonicalLeagueId: leagueId,
  });

  await client.execute({
    sql: "UPDATE admin_unmatched_leagues SET status = 'mapped' WHERE id = ?",
    args: [unmatchedLeagueId],
  });

  return { ok: true };
}

export async function ignoreUnmatchedLeague(unmatchedLeagueId) {
  const client = await createTursoClient();
  await client.execute({
    sql: "UPDATE admin_unmatched_leagues SET status = 'ignored' WHERE id = ?",
    args: [unmatchedLeagueId],
  });
  return { ok: true };
}

export async function mapUnmatchedEvent({
  unmatchedEventId,
  canonicalCountryName,
  canonicalHomeName,
  canonicalAwayName,
}) {
  const client = await createTursoClient();
  const unmatched = await client.execute({
    sql: `
      SELECT id, bookmaker_slug, source_home_name, source_away_name
      FROM admin_unmatched_events
      WHERE id = ?
    `,
    args: [unmatchedEventId],
  });

  const row = unmatched.rows[0];

  if (!row) {
    throw new Error("Unmatched event not found.");
  }

  const bookmakerId = await getBookmakerId(client, row.bookmaker_slug);
  const countryId = canonicalCountryName
    ? await getOrCreateCountry(client, canonicalCountryName)
    : null;
  const homeTeamId = await getOrCreateTeam(client, countryId, canonicalHomeName);
  const awayTeamId = await getOrCreateTeam(client, countryId, canonicalAwayName);

  await upsertTeamMapping({
    client,
    bookmakerId,
    sourceTeamName: row.source_home_name,
    canonicalTeamId: homeTeamId,
  });

  await upsertTeamMapping({
    client,
    bookmakerId,
    sourceTeamName: row.source_away_name,
    canonicalTeamId: awayTeamId,
  });

  await client.execute({
    sql: `
      INSERT INTO admin_match_decisions (unmatched_event_id, decision_type, payload_json)
      VALUES (?, 'create_alias', ?)
    `,
    args: [
      unmatchedEventId,
      JSON.stringify({
        canonicalCountryName,
        canonicalHomeName,
        canonicalAwayName,
      }),
    ],
  });

  await client.execute({
    sql: "UPDATE admin_unmatched_events SET status = 'matched' WHERE id = ?",
    args: [unmatchedEventId],
  });

  return { ok: true };
}

export async function ignoreUnmatchedEvent(unmatchedEventId) {
  const client = await createTursoClient();
  await client.execute({
    sql: "UPDATE admin_unmatched_events SET status = 'ignored' WHERE id = ?",
    args: [unmatchedEventId],
  });
  return { ok: true };
}

async function requireBookmakerId(client, bookmakerSlug) {
  const bookmakerId = await getBookmakerId(client, bookmakerSlug);

  if (!bookmakerId) {
    throw new Error(`Unknown bookmaker slug: ${bookmakerSlug}`);
  }

  return bookmakerId;
}

export async function listAdminMappingData({
  optionLimit = DEFAULT_ADMIN_MAPPING_OPTION_LIMIT,
  mappedLimit = DEFAULT_ADMIN_MAPPED_LIST_LIMIT,
} = {}) {
  const client = await getClientIfConfigured();

  if (!client) {
    return {
      bookmakers: [],
      sourceLeagueOptions: [],
      sourceTeamOptions: [],
      canonicalLeagueOptions: [],
      canonicalTeamOptions: [],
      mappedLeagues: [],
      mappedTeams: [],
    };
  }

  const [
    bookmakers,
    sourceLeagueOptions,
    sourceTeamOptions,
    canonicalLeagueOptions,
    canonicalTeamOptions,
    mappedLeagues,
    mappedTeams,
  ] = await Promise.all([
    client.execute(`
      SELECT slug, display_name
      FROM admin_bookmakers
      ORDER BY display_name ASC
    `),
    client.execute({
      sql: `
      WITH grouped AS (
        SELECT
          bookmaker_slug,
          source_country_name,
          source_league_name,
          MAX(last_seen_at) AS last_seen_at,
          SUM(seen_count) AS seen_count
        FROM admin_unmatched_leagues
        WHERE status = 'open'
        GROUP BY bookmaker_slug, source_country_name, source_league_name
      ),
      ranked AS (
        SELECT
          bookmaker_slug,
          source_country_name,
          source_league_name,
          last_seen_at,
          seen_count,
          ROW_NUMBER() OVER (
            PARTITION BY bookmaker_slug
            ORDER BY source_country_name ASC, source_league_name ASC
          ) AS bookmaker_row_num
        FROM grouped
      )
      SELECT
        bookmaker_slug,
        source_country_name,
        source_league_name,
        last_seen_at,
        seen_count
      FROM ranked
      WHERE bookmaker_row_num <= ?
      ORDER BY bookmaker_slug ASC, source_country_name ASC, source_league_name ASC
    `,
      args: [optionLimit],
    }),
    client.execute({
      sql: `
      WITH grouped AS (
        SELECT
          bookmaker_slug,
          source_team_name,
          source_league_name,
          source_country_name,
          MAX(last_seen_at) AS last_seen_at,
          SUM(seen_count) AS seen_count
        FROM (
          SELECT bookmaker_slug, source_home_name AS source_team_name, source_league_name, source_country_name, last_seen_at, seen_count
          FROM admin_unmatched_events
          WHERE status = 'open'
          UNION ALL
          SELECT bookmaker_slug, source_away_name AS source_team_name, source_league_name, source_country_name, last_seen_at, seen_count
          FROM admin_unmatched_events
          WHERE status = 'open'
        )
        GROUP BY bookmaker_slug, source_team_name, source_league_name, source_country_name
      ),
      ranked AS (
        SELECT
          bookmaker_slug,
          source_team_name,
          source_league_name,
          source_country_name,
          last_seen_at,
          seen_count,
          ROW_NUMBER() OVER (
            PARTITION BY bookmaker_slug
            ORDER BY source_league_name ASC, source_team_name ASC
          ) AS bookmaker_row_num
        FROM grouped
      )
      SELECT
        bookmaker_slug,
        source_team_name,
        source_league_name,
        source_country_name,
        last_seen_at,
        seen_count
      FROM ranked
      WHERE bookmaker_row_num <= ?
      ORDER BY bookmaker_slug ASC, source_league_name ASC, source_team_name ASC
    `,
      args: [optionLimit],
    }),
    client.execute(`
      SELECT
        cl.id,
        cl.name AS canonical_league_name,
        cc.name AS canonical_country_name
      FROM admin_canonical_leagues cl
      LEFT JOIN admin_canonical_countries cc ON cc.id = cl.canonical_country_id
      ORDER BY
        CASE WHEN cc.name IS NULL OR cc.name = '' THEN 1 ELSE 0 END,
        cc.name ASC,
        cl.name ASC
    `),
    client.execute(`
      SELECT
        ct.id,
        ct.name AS canonical_team_name,
        cc.name AS canonical_country_name
      FROM admin_canonical_teams ct
      LEFT JOIN admin_canonical_countries cc ON cc.id = ct.canonical_country_id
      ORDER BY
        CASE WHEN cc.name IS NULL OR cc.name = '' THEN 1 ELSE 0 END,
        cc.name ASC,
        ct.name ASC
    `),
    client.execute({
      sql: `
      SELECT
        lm.id,
        b.slug AS bookmaker_slug,
        b.display_name AS bookmaker_name,
        lm.source_country_name,
        lm.source_league_name,
        cc.name AS canonical_country_name,
        cl.name AS canonical_league_name,
        lm.confidence,
        lm.created_at
      FROM admin_league_mappings lm
      JOIN admin_bookmakers b ON b.id = lm.bookmaker_id
      JOIN admin_canonical_leagues cl ON cl.id = lm.canonical_league_id
      LEFT JOIN admin_canonical_countries cc ON cc.id = cl.canonical_country_id
      WHERE lm.is_active = 1
      ORDER BY b.display_name ASC, lm.source_country_name ASC, lm.source_league_name ASC
      LIMIT ?
    `,
      args: [mappedLimit],
    }),
    client.execute({
      sql: `
      SELECT
        tm.id,
        b.slug AS bookmaker_slug,
        b.display_name AS bookmaker_name,
        tm.source_team_name,
        cc.name AS canonical_country_name,
        ct.name AS canonical_team_name,
        tm.confidence,
        tm.created_at
      FROM admin_team_mappings tm
      JOIN admin_bookmakers b ON b.id = tm.bookmaker_id
      JOIN admin_canonical_teams ct ON ct.id = tm.canonical_team_id
      LEFT JOIN admin_canonical_countries cc ON cc.id = ct.canonical_country_id
      WHERE tm.is_active = 1
      ORDER BY b.display_name ASC, tm.source_team_name ASC
      LIMIT ?
    `,
      args: [mappedLimit],
    }),
  ]);

  return {
    bookmakers: bookmakers.rows,
    sourceLeagueOptions: sourceLeagueOptions.rows,
    sourceTeamOptions: sourceTeamOptions.rows,
    canonicalLeagueOptions: canonicalLeagueOptions.rows,
    canonicalTeamOptions: canonicalTeamOptions.rows,
    mappedLeagues: mappedLeagues.rows,
    mappedTeams: mappedTeams.rows,
  };
}

export async function createLeagueMapping({
  bookmakerSlug,
  sourceCountryName,
  sourceLeagueName,
  canonicalCountryName,
  canonicalLeagueName,
}) {
  const client = await createTursoClient();
  const bookmakerId = await requireBookmakerId(client, bookmakerSlug);
  const countryId = canonicalCountryName
    ? await getOrCreateCountry(client, canonicalCountryName)
    : null;
  const canonicalLeagueId = await getOrCreateLeague(client, countryId, canonicalLeagueName);

  console.log("[createLeagueMapping] args", {
    bookmakerSlug, sourceCountryName, sourceLeagueName,
    countryId, canonicalLeagueId,
    bookmakerId,
    types: { bookmakerId: typeof bookmakerId, canonicalLeagueId: typeof canonicalLeagueId, countryId: typeof countryId },
  });

  await upsertLeagueMapping({
    client,
    bookmakerId,
    sourceCountryName: cleanDisplayText(sourceCountryName),
    sourceLeagueName: cleanDisplayText(sourceLeagueName),
    canonicalLeagueId,
  });

  await client.execute({
    sql: `
      UPDATE admin_unmatched_leagues
      SET status = 'mapped'
      WHERE bookmaker_slug = ?
        AND COALESCE(source_country_name, '') = COALESCE(?, '')
        AND source_league_name = ?
    `,
    args: [
      bookmakerSlug,
      cleanDisplayText(sourceCountryName),
      cleanDisplayText(sourceLeagueName),
    ],
  });

  return { ok: true };
}

export async function createTeamMapping({
  bookmakerSlug,
  sourceTeamName,
  canonicalCountryName,
  canonicalTeamName,
}) {
  const client = await createTursoClient();
  const bookmakerId = await requireBookmakerId(client, bookmakerSlug);
  const countryId = canonicalCountryName
    ? await getOrCreateCountry(client, canonicalCountryName)
    : null;
  const canonicalTeamId = await getOrCreateTeam(client, countryId, canonicalTeamName);

  await upsertTeamMapping({
    client,
    bookmakerId,
    sourceTeamName: cleanDisplayText(sourceTeamName),
    canonicalTeamId,
  });

  return { ok: true };
}

export async function unmapLeagueMapping(mappingId) {
  const client = await createTursoClient();
  await client.execute({
    sql: "UPDATE admin_league_mappings SET is_active = 0 WHERE id = ?",
    args: [mappingId],
  });
  return { ok: true };
}

export async function unmapTeamMapping(mappingId) {
  const client = await createTursoClient();
  await client.execute({
    sql: "UPDATE admin_team_mappings SET is_active = 0 WHERE id = ?",
    args: [mappingId],
  });
  return { ok: true };
}
