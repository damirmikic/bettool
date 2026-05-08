import { normalizeEventKey } from "./normalize.js";

function bestPriceLabel(leftPrice, rightPrice) {
  if (leftPrice == null && rightPrice == null) {
    return "-";
  }

  if (leftPrice == null) {
    return "Pinnacle";
  }

  if (rightPrice == null) {
    return "MerkurXTip";
  }

  if (leftPrice === rightPrice) {
    return "Equal";
  }

  return leftPrice > rightPrice ? "MerkurXTip" : "Pinnacle";
}

function createOutcomeComparison(label, leftPrice, rightPrice) {
  return {
    label,
    leftPrice,
    rightPrice,
    bestBookmaker: bestPriceLabel(leftPrice, rightPrice),
    delta:
      leftPrice != null && rightPrice != null
        ? Number((leftPrice - rightPrice).toFixed(3))
        : null,
    bestPrice:
      leftPrice == null && rightPrice == null
        ? null
        : Math.max(leftPrice ?? 0, rightPrice ?? 0),
  };
}

function calculateArbitrage(outcomes) {
  const bestPrices = outcomes.map((outcome) => outcome.bestPrice).filter((price) => price != null);

  if (bestPrices.length !== 3) {
    return {
      isArbitrage: false,
      arbitrageMargin: null,
      payoutRate: null,
    };
  }

  const inverseSum = bestPrices.reduce((sum, price) => sum + 1 / price, 0);
  const payoutRate = Number((1 / inverseSum).toFixed(4));

  return {
    isArbitrage: inverseSum < 1,
    arbitrageMargin: Number((inverseSum * 100).toFixed(2)),
    payoutRate,
  };
}

export function compareBooks({
  leftBookmaker,
  rightBookmaker,
  leftEvents,
  rightEvents,
}) {
  const rightEventsByKey = new Map(
    rightEvents.map((event) => [normalizeEventKey(event.key), event]),
  );
  const matchedRightKeys = new Set();
  const matchedComparisons = [];
  const unmatchedLeftEvents = [];

  for (const leftEvent of leftEvents) {
    const normalizedKey = normalizeEventKey(leftEvent.key);
    const rightEvent = rightEventsByKey.get(normalizedKey);

    if (!rightEvent) {
      unmatchedLeftEvents.push(leftEvent);
      continue;
    }

    matchedRightKeys.add(normalizedKey);
    const outcomes = [
      createOutcomeComparison(
        "1",
        leftEvent.markets.moneyline?.home ?? null,
        rightEvent.markets.moneyline?.home ?? null,
      ),
      createOutcomeComparison(
        "X",
        leftEvent.markets.moneyline?.draw ?? null,
        rightEvent.markets.moneyline?.draw ?? null,
      ),
      createOutcomeComparison(
        "2",
        leftEvent.markets.moneyline?.away ?? null,
        rightEvent.markets.moneyline?.away ?? null,
      ),
    ];
    const arbitrage = calculateArbitrage(outcomes);
    const bestBookmakerCount = outcomes.filter(
      (outcome) => outcome.bestBookmaker === leftBookmaker,
    ).length;
    const maxDeltaAbs = Number(
      Math.max(...outcomes.map((outcome) => Math.abs(outcome.delta ?? 0))).toFixed(3),
    );

    matchedComparisons.push({
      key: leftEvent.key,
      country: leftEvent.country || rightEvent.country || null,
      league: leftEvent.league || rightEvent.league,
      startTime: leftEvent.startTime || rightEvent.startTime,
      bookmakers: [leftBookmaker, rightBookmaker],
      outcomes,
      maxDeltaAbs,
      bestBookmakerCount,
      ...arbitrage,
    });
  }

  const unmatchedRightEvents = rightEvents.filter(
    (event) => !matchedRightKeys.has(normalizeEventKey(event.key)),
  );

  return {
    comparisons: matchedComparisons.sort((a, b) => b.maxDeltaAbs - a.maxDeltaAbs),
    unmatchedLeftEvents,
    unmatchedRightEvents,
  };
}
