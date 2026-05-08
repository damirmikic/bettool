import { fetchJson, HttpError } from "../lib/http.js";
import { cleanDisplayText, createEventKey } from "../lib/normalize.js";

const PINNACLE_LEAGUES_URL =
  "https://www.pinnacle888.com/sports-service/sv/euro/leagues?sportId=29&locale=en_US&withCredentials=true";
const PINNACLE_LEAGUE_ODDS_URL =
  "https://www.pinnacle888.com/sports-service/sv/euro/odds/league?sportId=29&oddsType=1&version=0&periodNum=-1&eSportCode=&locale=en_US&isHlE=true&isLive=false&eventType=0&withCredentials=true";
const PINNACLE_LEAGUE_DELAY_MS = 900;
const DEFAULT_PINNACLE_BATCH_SIZE = 50;
const DEFAULT_PINNACLE_FIRST_BATCH_SIZE = 10;
const DEFAULT_PINNACLE_CONCURRENCY = 2;
const PINNACLE_RATE_LIMIT_COOLDOWN_MS = 8_000;
const PINNACLE_MAX_RETRY_ATTEMPTS = 3;

let nextPinnacleRequestAt = 0;

function sleep(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function mapMoneyline(period) {
  const moneyLine = period?.moneyLine ?? period?.moneyline ?? null;
  const home = Number(moneyLine?.homePrice ?? moneyLine?.home);
  const draw = Number(moneyLine?.drawPrice ?? moneyLine?.draw);
  const away = Number(moneyLine?.awayPrice ?? moneyLine?.away);
  const normalizePrice = (price) => (Number.isFinite(price) && price > 1 ? price : null);

  if (!normalizePrice(home) && !normalizePrice(draw) && !normalizePrice(away)) {
    return null;
  }

  return {
    home: normalizePrice(home),
    draw: normalizePrice(draw),
    away: normalizePrice(away),
  };
}

function mapPinnacleEvent(rawEvent, leagueName) {
  const participants = Array.isArray(rawEvent.participants) ? rawEvent.participants : [];
  const homeParticipant = participants.find((participant) => participant?.type === "HOME");
  const awayParticipant = participants.find((participant) => participant?.type === "AWAY");
  const home = cleanDisplayText(
    rawEvent.home ??
    rawEvent.homeTeam ??
    homeParticipant?.englishName ??
    homeParticipant?.name ??
    participants[0]?.name,
  );
  const away = cleanDisplayText(
    rawEvent.away ??
    rawEvent.awayTeam ??
    awayParticipant?.englishName ??
    awayParticipant?.name ??
    participants[1]?.name,
  );
  const periods = rawEvent.periods ?? {};
  const fullGamePeriod = periods["0"] ?? periods[0] ?? null;
  const moneyline = mapMoneyline(fullGamePeriod);

  if (!home || !away || !moneyline) {
    return null;
  }

  return {
    source: "Pinnacle",
    id: rawEvent.id ?? rawEvent.eventId ?? null,
    key: createEventKey(home, away),
    country: cleanDisplayText(rawEvent.container ?? rawEvent.countryName ?? leagueName),
    league: cleanDisplayText(leagueName ?? rawEvent.league),
    startTime: rawEvent.starts ?? rawEvent.startTime ?? rawEvent.time ?? null,
    markets: {
      moneyline,
    },
    raw: rawEvent,
  };
}

async function fetchLeagueCodes() {
  const payload = await fetchJson(PINNACLE_LEAGUES_URL, {
    retries: 2,
    retryDelayMs: 700,
  });

  if (Array.isArray(payload)) {
    return payload
      .map((league) => ({
        code: league.leagueCode ?? league.code,
        country: cleanDisplayText(league.container ?? league.countryName),
        name: cleanDisplayText(league.name ?? league.leagueName),
      }))
      .filter((league) => league.code);
  }

  const leagues = Array.isArray(payload?.leagues) ? payload.leagues : [];

  return leagues
    .map((league) => ({
      code: league.leagueCode ?? league.code,
      country: cleanDisplayText(league.container ?? league.countryName),
      name: cleanDisplayText(league.name ?? league.leagueName),
    }))
    .filter((league) => league.code);
}

async function fetchLeagueOdds(league) {
  const url = `${PINNACLE_LEAGUE_ODDS_URL}&leagueCode=${encodeURIComponent(league.code)}`;
  const payload = await fetchJson(url, {
    retries: 4,
    retryDelayMs: 1_200,
  });
  const events = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.events)
      ? payload.events
      : Array.isArray(payload?.leagues)
        ? payload.leagues.flatMap((entry) => entry?.events ?? [])
        : [];

  return events
    .map((event) => ({
      ...event,
      container: event.container ?? league.country,
    }))
    .map((event) => mapPinnacleEvent(event, league.name))
    .filter(Boolean);
}

async function waitForRequestSlot() {
  const delayMs = Math.max(0, nextPinnacleRequestAt - Date.now());

  if (delayMs > 0) {
    await sleep(delayMs);
  }

  nextPinnacleRequestAt = Date.now() + PINNACLE_LEAGUE_DELAY_MS;
}

function isRateLimited(error) {
  return error instanceof HttpError && error.status === 429;
}

async function fetchLeagueOddsWithThrottle(league) {
  for (let attempt = 0; attempt <= PINNACLE_MAX_RETRY_ATTEMPTS; attempt += 1) {
    await waitForRequestSlot();

    try {
      return await fetchLeagueOdds(league);
    } catch (error) {
      if (isRateLimited(error) && attempt < PINNACLE_MAX_RETRY_ATTEMPTS) {
        const cooldownMs = Math.max(
          error.retryAfterMs ?? 0,
          PINNACLE_RATE_LIMIT_COOLDOWN_MS * (attempt + 1),
        );
        nextPinnacleRequestAt = Math.max(nextPinnacleRequestAt, Date.now() + cooldownMs);
        continue;
      }

      throw error;
    }
  }
}

async function fetchLeagueOddsInBatches(leagues) {
  const results = [];

  for (const league of leagues) {
    try {
      const leagueEvents = await fetchLeagueOddsWithThrottle(league);
      results.push(...leagueEvents);
    } catch (error) {
      console.warn(
        `Skipping Pinnacle league ${league.code}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return results;
}

async function fetchLeagueOddsWithConcurrency(leagues, concurrency) {
  const results = [];
  const queue = [...leagues];

  async function worker() {
    while (queue.length > 0) {
      const league = queue.shift();

      if (!league) {
        return;
      }

      try {
        const leagueEvents = await fetchLeagueOddsWithThrottle(league);
        results.push(...leagueEvents);
      } catch (error) {
        console.warn(
          `Skipping Pinnacle league ${league.code}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, () => worker()),
  );

  return results;
}

export async function fetchPinnacleSoccerOffer() {
  const leagues = await fetchLeagueCodes();
  return fetchLeagueOddsInBatches(leagues);
}

export async function fetchPinnacleSoccerOfferProgressive({
  batchSize = DEFAULT_PINNACLE_BATCH_SIZE,
  firstBatchSize = DEFAULT_PINNACLE_FIRST_BATCH_SIZE,
  concurrency = DEFAULT_PINNACLE_CONCURRENCY,
  onBatch,
} = {}) {
  const leagues = await fetchLeagueCodes();
  const results = [];
  let loadedLeagueCount = 0;
  let index = 0;

  while (index < leagues.length) {
    const currentBatchSize = index === 0 ? firstBatchSize : batchSize;
    const leagueBatch = leagues.slice(index, index + currentBatchSize);
    const batchEvents = await fetchLeagueOddsWithConcurrency(leagueBatch, concurrency);
    results.push(...batchEvents);
    loadedLeagueCount += leagueBatch.length;

    if (onBatch) {
      await onBatch({
        batchEvents,
        allEvents: [...results],
        progress: {
          loadedLeagueCount,
          totalLeagueCount: leagues.length,
          batchSize: leagueBatch.length,
          isComplete: loadedLeagueCount >= leagues.length,
        },
      });
    }

    index += currentBatchSize;
  }

  return {
    events: results,
    totalLeagueCount: leagues.length,
  };
}
