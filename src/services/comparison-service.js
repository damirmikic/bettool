import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { compareBooks } from "../lib/compare.js";
import { fetchMerkurSoccerOffer } from "../providers/merkur.js";
import { fetchPinnacleSoccerOfferProgressive } from "../providers/pinnacle.js";
import { loadAdminMappings, saveUnmatchedReviewData } from "../db/admin-repository.js";

const CACHE_TTL_MS = 60_000;
const SNAPSHOT_PATH = resolve(process.cwd(), "data", "cache", "comparisons.json");

let cache = {
  data: null,
  expiresAt: 0,
  pending: null,
  warmStarted: false,
  firstReady: null,
};

function withRefreshingProgress(snapshot) {
  if (!snapshot) {
    return null;
  }

  return {
    ...snapshot,
    progress: {
      loadedLeagueCount: snapshot.progress?.loadedLeagueCount ?? 0,
      totalLeagueCount: snapshot.progress?.totalLeagueCount ?? 0,
      batchSize: snapshot.progress?.batchSize ?? 0,
      isPartial: snapshot.progress?.isPartial ?? false,
      isRefreshing: true,
    },
  };
}

function numericLimit(rawLimit, fallback) {
  if (rawLimit == null || rawLimit === "") {
    return fallback;
  }

  if (rawLimit === "all") {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Number(rawLimit);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function buildSummary(comparisons) {
  const arbitrageCount = comparisons.filter((comparison) => comparison.isArbitrage).length;
  const leagues = new Set(comparisons.map((comparison) => comparison.league).filter(Boolean));
  const averageEdge =
    comparisons.length > 0
      ? Number(
          (
            comparisons.reduce((sum, comparison) => sum + comparison.maxDeltaAbs, 0) /
            comparisons.length
          ).toFixed(3),
        )
      : 0;

  return {
    arbitrageCount,
    averageEdge,
    leagueCount: leagues.size,
  };
}

function buildLeagueIndex(comparisons) {
  return [...new Set(comparisons.map((comparison) => comparison.league).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function buildCountryLeagueTree(comparisons) {
  const countries = new Map();

  for (const comparison of comparisons) {
    const countryName = comparison.country ?? "Other";
    const leagueName = comparison.league ?? "Unknown league";
    const entry = countries.get(countryName) ?? {
      name: countryName,
      count: 0,
      leagues: new Map(),
    };

    entry.count += 1;
    entry.leagues.set(leagueName, (entry.leagues.get(leagueName) ?? 0) + 1);
    countries.set(countryName, entry);
  }

  return [...countries.values()]
    .map((country) => ({
      name: country.name,
      count: country.count,
      leagues: [...country.leagues.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function buildComparisonRowKey(comparison) {
  return [
    comparison.key?.home ?? "",
    comparison.key?.away ?? "",
    comparison.country ?? "",
    comparison.league ?? "",
    comparison.startTime ?? "",
  ].join("::");
}

function hasOutcomeFieldChanged(currentValue, previousValue) {
  return (currentValue ?? null) !== (previousValue ?? null);
}

function annotateComparisonChanges(comparisons, previousComparisons = []) {
  const previousByKey = new Map(
    previousComparisons.map((comparison) => [buildComparisonRowKey(comparison), comparison]),
  );

  return comparisons.map((comparison) => {
    const previousComparison = previousByKey.get(buildComparisonRowKey(comparison)) ?? null;
    let changedOutcomeCount = 0;

    const outcomes = comparison.outcomes.map((outcome) => {
      const previousOutcome =
        previousComparison?.outcomes?.find((candidate) => candidate.label === outcome.label) ??
        null;

      if (!previousOutcome) {
        return {
          ...outcome,
          hasChanged: false,
          changeFlags: {
            leftPrice: false,
            rightPrice: false,
            bestPrice: false,
            noVigPrice: false,
            valuePercentage: false,
            delta: false,
          },
          previousState: null,
        };
      }

      const changeFlags = {
        leftPrice: hasOutcomeFieldChanged(outcome.leftPrice, previousOutcome.leftPrice),
        rightPrice: hasOutcomeFieldChanged(outcome.rightPrice, previousOutcome.rightPrice),
        bestPrice: hasOutcomeFieldChanged(outcome.bestPrice, previousOutcome.bestPrice),
        noVigPrice: hasOutcomeFieldChanged(outcome.noVigPrice, previousOutcome.noVigPrice),
        valuePercentage: hasOutcomeFieldChanged(
          outcome.valuePercentage,
          previousOutcome.valuePercentage,
        ),
        delta: hasOutcomeFieldChanged(outcome.delta, previousOutcome.delta),
      };

      const hasChanged = Object.values(changeFlags).some(Boolean);

      if (hasChanged) {
        changedOutcomeCount += 1;
      }

      return {
        ...outcome,
        hasChanged,
        changeFlags,
        previousState: {
          leftPrice: previousOutcome.leftPrice ?? null,
          rightPrice: previousOutcome.rightPrice ?? null,
          bestPrice: previousOutcome.bestPrice ?? null,
          noVigPrice: previousOutcome.noVigPrice ?? null,
          valuePercentage: previousOutcome.valuePercentage ?? null,
          delta: previousOutcome.delta ?? null,
        },
      };
    });

    return {
      ...comparison,
      hasChanged: changedOutcomeCount > 0,
      changedOutcomeCount,
      outcomes,
    };
  });
}

function countDistinctLeagues(events) {
  return new Set(events.map((event) => `${event.country ?? ""}::${event.league ?? ""}`)).size;
}

function resolveMappedCountry(row) {
  const canonicalCountry = row.canonical_country_name ?? null;
  const sourceCountry = row.source_country_name ?? null;
  const canonicalLeague = row.canonical_league_name ?? null;

  if (!canonicalCountry) {
    return sourceCountry;
  }

  const normalizedCountry = String(canonicalCountry).trim().toLowerCase();
  const normalizedLeague = String(canonicalLeague ?? "").trim().toLowerCase();

  if (normalizedLeague) {
    if (normalizedCountry === normalizedLeague) {
      return sourceCountry;
    }

    if (normalizedCountry.includes(normalizedLeague)) {
      return sourceCountry;
    }
  }

  return canonicalCountry;
}

function buildLeagueMappingIndex(rows) {
  const index = new Map();

  for (const row of rows) {
    const key = [
      String(row.bookmaker_slug ?? "").toLowerCase(),
      String(row.source_country_name ?? "").toLowerCase(),
      String(row.source_league_name ?? "").toLowerCase(),
    ].join("::");

    index.set(key, {
      country: resolveMappedCountry(row),
      league: row.canonical_league_name ?? row.source_league_name ?? null,
    });
  }

  return index;
}

function buildTeamMappingIndex(rows) {
  const index = new Map();

  for (const row of rows) {
    const key = [
      String(row.bookmaker_slug ?? "").toLowerCase(),
      String(row.source_team_name ?? "").toLowerCase(),
    ].join("::");

    index.set(key, row.canonical_team_name ?? row.source_team_name);
  }

  return index;
}

function getBookmakerSlug(event) {
  return String(event.source ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function applyAdminMappings(events, mappings) {
  const leagueIndex = buildLeagueMappingIndex(mappings.leagueMappings);
  const teamIndex = buildTeamMappingIndex(mappings.teamMappings);

  return events.map((event) => {
    const bookmakerSlug = getBookmakerSlug(event);
    const sourceCountry = event.country ?? null;
    const sourceLeague = event.league ?? null;
    const sourceHome = event.key.home;
    const sourceAway = event.key.away;
    const leagueKey = [
      bookmakerSlug,
      String(sourceCountry ?? "").toLowerCase(),
      String(sourceLeague ?? "").toLowerCase(),
    ].join("::");
    const leagueMapping = leagueIndex.get(leagueKey);
    const homeMapping = teamIndex.get(
      [bookmakerSlug, String(sourceHome ?? "").toLowerCase()].join("::"),
    );
    const awayMapping = teamIndex.get(
      [bookmakerSlug, String(sourceAway ?? "").toLowerCase()].join("::"),
    );

    return {
      ...event,
      country: leagueMapping?.country ?? sourceCountry,
      league: leagueMapping?.league ?? sourceLeague,
      key: {
        home: homeMapping ?? sourceHome,
        away: awayMapping ?? sourceAway,
      },
      admin: {
        bookmakerSlug,
        sourceCountry,
        sourceLeague,
        sourceHome,
        sourceAway,
      },
    };
  });
}

function buildCurrentSourceTeamOptions(events) {
  const seen = new Set();
  const rows = [];

  for (const event of events) {
    const bookmakerSlug = event.admin?.bookmakerSlug ?? getBookmakerSlug(event);
    const sourceLeagueName = event.admin?.sourceLeague ?? event.league ?? null;
    const sourceCountryName = event.admin?.sourceCountry ?? event.country ?? null;
    const teamNames = [event.admin?.sourceHome ?? event.key.home, event.admin?.sourceAway ?? event.key.away];

    for (const sourceTeamName of teamNames) {
      if (!sourceTeamName) {
        continue;
      }

      const key = [
        bookmakerSlug,
        sourceCountryName ?? "",
        sourceLeagueName ?? "",
        sourceTeamName,
      ].join("::");

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      rows.push({
        bookmaker_slug: bookmakerSlug,
        source_team_name: sourceTeamName,
        source_league_name: sourceLeagueName,
        source_country_name: sourceCountryName,
      });
    }
  }

  return rows.sort((left, right) => {
    const bookmakerOrder = String(left.bookmaker_slug ?? "").localeCompare(String(right.bookmaker_slug ?? ""));
    if (bookmakerOrder !== 0) {
      return bookmakerOrder;
    }

    const leagueOrder = String(left.source_league_name ?? "").localeCompare(String(right.source_league_name ?? ""));
    if (leagueOrder !== 0) {
      return leagueOrder;
    }

    return String(left.source_team_name ?? "").localeCompare(String(right.source_team_name ?? ""));
  });
}

function buildUnmatchedLeagueRows(events) {
  const seen = new Set();
  const rows = [];

  for (const event of events) {
    const row = {
      bookmakerSlug: event.admin?.bookmakerSlug ?? getBookmakerSlug(event),
      country: event.country ?? null,
      league: event.league ?? "Unknown league",
    };
    const key = `${row.bookmakerSlug}::${row.country ?? ""}::${row.league}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    rows.push(row);
  }

  return rows;
}

function buildUnmatchedEventRows(events) {
  return events.map((event) => ({
    bookmakerSlug: event.admin?.bookmakerSlug ?? getBookmakerSlug(event),
    eventId: event.id != null ? String(event.id) : null,
    country: event.country ?? null,
    league: event.league ?? null,
    home: event.key.home,
    away: event.key.away,
    startTime: event.startTime ?? null,
  }));
}

async function buildComparisonData() {
  const previousSnapshot = cache.data ? withRefreshingProgress(cache.data) : null;
  const previousComparisons = cache.data?.comparisons ?? [];
  const [merkurEventsRaw, mappingsResult] = await Promise.all([
    fetchMerkurSoccerOffer(),
    loadAdminMappings().catch((error) => {
      console.warn(
        `Admin mappings unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        leagueMappings: [],
        teamMappings: [],
      };
    }),
  ]);

  const merkurEvents = applyAdminMappings(merkurEventsRaw, mappingsResult);
  let latestSnapshot = previousSnapshot ??
    createComparisonSnapshot({
      merkurEvents,
      pinnacleEvents: [],
      comparisonResult: {
        comparisons: [],
        unmatchedLeftEvents: merkurEvents,
        unmatchedRightEvents: [],
      },
      progress: {
        loadedLeagueCount: 0,
        totalLeagueCount: 0,
        isComplete: false,
        isRefreshing: true,
      },
      previousComparisons,
    });

  const firstReady = createDeferred();
  cache.firstReady = firstReady.promise;
  cache.data = latestSnapshot;

  try {
    const progressiveResult = await fetchPinnacleSoccerOfferProgressive({
      batchSize: 50,
      onBatch: async ({ allEvents, progress }) => {
        const pinnacleEvents = applyAdminMappings(allEvents, mappingsResult);
        const comparisonResult = compareBooks({
          leftBookmaker: "MerkurXTip",
          rightBookmaker: "Pinnacle",
          leftEvents: merkurEvents,
          rightEvents: pinnacleEvents,
        });

        latestSnapshot = createComparisonSnapshot({
          merkurEvents,
          pinnacleEvents,
          comparisonResult,
          progress: {
            ...progress,
            isRefreshing: !progress.isComplete,
          },
          previousComparisons,
        });

        cache.data = latestSnapshot;
        await saveSnapshotToDisk(latestSnapshot).catch((error) => {
          console.warn(
            `Unable to write comparison snapshot: ${error instanceof Error ? error.message : String(error)}`,
          );
        });

        if (!firstReady.settled) {
          firstReady.resolve(latestSnapshot);
          firstReady.settled = true;
        }

        if (progress.isComplete) {
          const unmatchedEvents = [
            ...buildUnmatchedEventRows(comparisonResult.unmatchedLeftEvents),
            ...buildUnmatchedEventRows(comparisonResult.unmatchedRightEvents),
          ];
          const unmatchedLeagues = buildUnmatchedLeagueRows([
            ...comparisonResult.unmatchedLeftEvents,
            ...comparisonResult.unmatchedRightEvents,
          ]);

          await saveUnmatchedReviewData({
            unmatchedLeagues,
            unmatchedEvents,
          }).catch((error) => {
            console.warn(
              `Unable to persist unmatched review data: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        }
      },
    });

    if (!firstReady.settled) {
      firstReady.resolve(latestSnapshot);
      firstReady.settled = true;
    }

    return {
      ...latestSnapshot,
      progress: {
        ...latestSnapshot.progress,
        loadedLeagueCount: progressiveResult.totalLeagueCount,
        totalLeagueCount: progressiveResult.totalLeagueCount,
        isComplete: true,
        isRefreshing: false,
        batchSize: latestSnapshot.progress.batchSize,
      },
    };
  } catch (error) {
    if (!firstReady.settled) {
      firstReady.reject(error);
      firstReady.settled = true;
    }
    throw error;
  }
}

function createComparisonSnapshot({
  merkurEvents,
  pinnacleEvents,
  comparisonResult,
  progress,
  previousComparisons = [],
}) {
  const comparisons = annotateComparisonChanges(
    comparisonResult.comparisons,
    previousComparisons,
  );
  const changedRows = comparisons.filter((comparison) => comparison.hasChanged);
  const changedOutcomeCount = changedRows.reduce(
    (sum, comparison) => sum + (comparison.changedOutcomeCount ?? 0),
    0,
  );
  const unmatchedEvents = [
    ...buildUnmatchedEventRows(comparisonResult.unmatchedLeftEvents),
    ...buildUnmatchedEventRows(comparisonResult.unmatchedRightEvents),
  ];
  const unmatchedLeagues = buildUnmatchedLeagueRows([
    ...comparisonResult.unmatchedLeftEvents,
    ...comparisonResult.unmatchedRightEvents,
  ]);
  const sourceTeamOptions = buildCurrentSourceTeamOptions([
    ...merkurEvents,
    ...pinnacleEvents,
  ]);

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      merkurEvents: merkurEvents.length,
      pinnacleEvents: pinnacleEvents.length,
      matchedEvents: comparisons.length,
    },
    coverage: {
      merkur: {
        totalMatches: merkurEvents.length,
        totalLeagues: countDistinctLeagues(merkurEvents),
      },
      pinnacle: {
        totalMatches: pinnacleEvents.length,
        totalLeagues: countDistinctLeagues(pinnacleEvents),
      },
      comparable: {
        matchedMatches: comparisons.length,
        matchedLeagues: buildLeagueIndex(comparisons).length,
      },
    },
    summary: buildSummary(comparisons),
    leagues: buildLeagueIndex(comparisons),
    countries: buildCountryLeagueTree(comparisons),
    comparisons,
    changes: {
      count: changedRows.length,
      outcomeCount: changedOutcomeCount,
      rows: changedRows,
    },
    sourceTeamOptions,
    unmatched: {
      leagues: unmatchedLeagues.length,
      events: unmatchedEvents.length,
    },
    progress: {
      loadedLeagueCount: progress.loadedLeagueCount ?? 0,
      totalLeagueCount: progress.totalLeagueCount ?? 0,
      batchSize: progress.batchSize ?? 0,
      isPartial: !progress.isComplete,
      isRefreshing: progress.isRefreshing ?? false,
    },
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {
    promise,
    resolve,
    reject,
    settled: false,
  };
}

async function loadSnapshotFromDisk() {
  try {
    const raw = await readFile(SNAPSHOT_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveSnapshotToDisk(data) {
  await mkdir(dirname(SNAPSHOT_PATH), { recursive: true });
  await writeFile(SNAPSHOT_PATH, JSON.stringify(data), "utf8");
}

async function refreshComparisonCache() {
  const data = await buildComparisonData();
  cache.data = data;
  cache.expiresAt = Date.now() + CACHE_TTL_MS;
  await saveSnapshotToDisk(data).catch((error) => {
    console.warn(
      `Unable to write comparison snapshot: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  return data;
}

function startBackgroundRefresh() {
  if (cache.pending) {
    return cache.pending;
  }

  cache.pending = refreshComparisonCache().finally(() => {
    cache.pending = null;
  });

  return cache.pending;
}

export async function getComparisonData({ forceRefresh = false } = {}) {
  const now = Date.now();

  if (!forceRefresh && cache.data && cache.expiresAt > now) {
    return cache.data;
  }

  if (!forceRefresh) {
    if (cache.data) {
      if (cache.pending) {
        return cache.data;
      }

      void startBackgroundRefresh();
      return cache.data;
    }

    if (!cache.data) {
      const snapshot = await loadSnapshotFromDisk();

      if (snapshot) {
        cache.data = snapshot;
        cache.expiresAt = 0;
        void startBackgroundRefresh();
        return snapshot;
      }

      startBackgroundRefresh();
      if (cache.firstReady) {
        return cache.firstReady;
      }
    }
  }

  if (!forceRefresh && cache.pending) {
    return cache.firstReady ?? cache.pending;
  }

  return startBackgroundRefresh();
}

export function warmComparisonCache() {
  if (cache.warmStarted) {
    return;
  }

  cache.warmStarted = true;
  void startBackgroundRefresh();
}

export function projectComparisonData(data, filters = {}) {
  const limit = numericLimit(filters.limit, 50);
  const search = String(filters.search ?? "").trim().toLowerCase();
  const country = String(filters.country ?? "").trim().toLowerCase();
  const league = String(filters.league ?? "").trim().toLowerCase();
  const sort = String(filters.sort ?? "edge");

  let rows = data.comparisons.filter((comparison) => {
    const matchesCountry =
      !country || String(comparison.country ?? "").toLowerCase() === country;
    const matchesLeague =
      !league || String(comparison.league ?? "").toLowerCase() === league;
    const haystack =
      `${comparison.key.home} ${comparison.key.away} ${comparison.league ?? ""} ${comparison.country ?? ""}`.toLowerCase();
    const matchesSearch = !search || haystack.includes(search);

    return matchesCountry && matchesLeague && matchesSearch;
  });

  rows = [...rows];

  if (sort === "start") {
    rows.sort((left, right) => (left.startTime ?? 0) - (right.startTime ?? 0));
  } else if (sort === "arb") {
    rows.sort((left, right) => {
      if (left.isArbitrage !== right.isArbitrage) {
        return left.isArbitrage ? -1 : 1;
      }

      return (left.arbitrageMargin ?? 999) - (right.arbitrageMargin ?? 999);
    });
  } else {
    rows.sort((left, right) => right.maxDeltaAbs - left.maxDeltaAbs);
  }

  return {
    generatedAt: data.generatedAt,
    counts: data.counts,
    coverage: data.coverage,
    summary: data.summary,
    changes: data.changes ?? {
      count: 0,
      outcomeCount: 0,
      rows: [],
    },
    leagues: data.leagues,
    countries: data.countries,
    progress: data.progress ?? {
      loadedLeagueCount: 0,
      totalLeagueCount: 0,
      batchSize: 0,
      isPartial: false,
      isRefreshing: false,
    },
    appliedFilters: {
      search: filters.search ?? "",
      country: filters.country ?? "",
      league: filters.league ?? "",
      sort,
      limit: Number.isFinite(limit) ? limit : "all",
    },
    totalRows: rows.length,
    rows: rows.slice(0, limit),
  };
}
