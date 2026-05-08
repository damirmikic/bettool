import { fetchJson } from "../lib/http.js";
import { cleanDisplayText, createEventKey } from "../lib/normalize.js";

const MERKUR_URL =
  "https://www.merkurxtip.rs/restapi/offer/sr/sport/S/mob?annex=0&desktopVersion=2.44.3.18&locale=sr";

function extractMerkurCountry(rawEvent) {
  const groupToken = cleanDisplayText(rawEvent.leagueGroupToken);

  if (groupToken) {
    const parts = groupToken.split("#").map((part) => cleanDisplayText(part)).filter(Boolean);

    if (parts.length >= 2) {
      return parts[1];
    }
  }

  const leagueName = cleanDisplayText(rawEvent.leagueName ?? rawEvent.competitionName);

  if (leagueName?.includes(" - ")) {
    return cleanDisplayText(leagueName.split(" - ")[0]);
  }

  return null;
}

function extractMoneylineFromBetMap(betMap) {
  if (!betMap || typeof betMap !== "object") {
    return null;
  }

  if ("1" in betMap || "2" in betMap || "3" in betMap) {
    const values = {
      home: Number(betMap["1"]),
      draw: Number(betMap["2"]),
      away: Number(betMap["3"]),
    };

    return values.home || values.draw || values.away ? values : null;
  }

  const pairs = Object.entries(betMap);
  const home = pairs.find(([key]) => /(^|[^a-z])1([^a-z]|$)/i.test(key));
  const draw = pairs.find(([key]) => /(^|[^a-z])x([^a-z]|$)/i.test(key));
  const away = pairs.find(([key]) => /(^|[^a-z])2([^a-z]|$)/i.test(key));

  const values = {
    home: home ? Number(home[1]) : null,
    draw: draw ? Number(draw[1]) : null,
    away: away ? Number(away[1]) : null,
  };

  return values.home || values.draw || values.away ? values : null;
}

function extractMoneylineFromMarkets(markets) {
  if (!Array.isArray(markets)) {
    return null;
  }

  for (const market of markets) {
    const title = `${market?.name ?? ""} ${market?.marketName ?? ""}`.toLowerCase();
    const isOneXTwo =
      title.includes("kona") ||
      title.includes("1x2") ||
      title.includes("ishod") ||
      title.includes("regular time");

    if (!isOneXTwo) {
      continue;
    }

    const selections = Array.isArray(market?.outcomes)
      ? market.outcomes
      : Array.isArray(market?.bets)
        ? market.bets
        : [];

    const moneyline = { home: null, draw: null, away: null };

    for (const selection of selections) {
      const label = String(selection?.name ?? selection?.label ?? "").trim().toUpperCase();
      const price = Number(selection?.odd ?? selection?.odds ?? selection?.value);

      if (!Number.isFinite(price)) {
        continue;
      }

      if (label === "1") {
        moneyline.home = price;
      } else if (label === "X") {
        moneyline.draw = price;
      } else if (label === "2") {
        moneyline.away = price;
      }
    }

    if (moneyline.home || moneyline.draw || moneyline.away) {
      return moneyline;
    }
  }

  return null;
}

function collectCandidateEvents(node, bucket) {
  if (!node || typeof node !== "object") {
    return;
  }

  if (
    (node.home || node.homeTeam || node.team1) &&
    (node.away || node.awayTeam || node.team2)
  ) {
    bucket.push(node);
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        collectCandidateEvents(item, bucket);
      }
    } else if (value && typeof value === "object") {
      collectCandidateEvents(value, bucket);
    }
  }
}

function mapMerkurEvent(rawEvent) {
  const home = cleanDisplayText(
    rawEvent.home ?? rawEvent.homeTeam ?? rawEvent.team1 ?? rawEvent.competitor1,
  );
  const away = cleanDisplayText(
    rawEvent.away ?? rawEvent.awayTeam ?? rawEvent.team2 ?? rawEvent.competitor2,
  );

  if (!home || !away) {
    return null;
  }

  const moneyline =
    extractMoneylineFromMarkets(rawEvent.markets) ??
    extractMoneylineFromBetMap(rawEvent.odds) ??
    extractMoneylineFromBetMap(rawEvent.bets);

  if (!moneyline) {
    return null;
  }

  return {
    source: "MerkurXTip",
    id: rawEvent.id ?? rawEvent.matchId ?? null,
    key: createEventKey(home, away),
    country: extractMerkurCountry(rawEvent),
    league: cleanDisplayText(
      rawEvent.leagueName ?? rawEvent.competitionName ?? rawEvent.categoryName,
    ),
    startTime:
      rawEvent.kickOffTime ??
      rawEvent.startTime ??
      rawEvent.time ??
      rawEvent.eventTime ??
      null,
    markets: {
      moneyline,
    },
    raw: rawEvent,
  };
}

export async function fetchMerkurSoccerOffer() {
  const payload = await fetchJson(MERKUR_URL);
  const candidates = [];

  collectCandidateEvents(payload, candidates);

  return candidates.map(mapMerkurEvent).filter(Boolean);
}
