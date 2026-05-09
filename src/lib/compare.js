import { normalizeEventKey, normalizeTeamName } from "./normalize.js";

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

function calculateShinMarket(outcomes) {
  const bestPrices = outcomes.map((outcome) => outcome.bestPrice);

  if (bestPrices.some((price) => price == null || !Number.isFinite(price) || price <= 1)) {
    return null;
  }

  const invertedOdds = bestPrices.map((price) => 1 / price);
  const booksum = invertedOdds.reduce((sum, price) => sum + price, 0);

  if (!(booksum > 1)) {
    return null;
  }

  const outcomeCount = invertedOdds.length;
  let z = 0;

  for (let iteration = 0; iteration < 1_000; iteration += 1) {
    const previousZ = z;
    const numerator = invertedOdds.reduce((sum, invertedPrice) => {
      return (
        sum +
        Math.sqrt(
          previousZ ** 2 + (4 * (1 - previousZ) * invertedPrice ** 2) / booksum,
        )
      );
    }, 0);

    z = (numerator - 2) / (outcomeCount - 2);
    z = Math.min(Math.max(z, 0), 0.999999999999);

    if (Math.abs(z - previousZ) <= 1e-12) {
      break;
    }
  }

  const probabilities = invertedOdds.map((invertedPrice) => {
    const numerator = Math.sqrt(z ** 2 + (4 * (1 - z) * invertedPrice ** 2) / booksum) - z;
    const denominator = 2 * (1 - z);
    return numerator / denominator;
  });

  const probabilitySum = probabilities.reduce((sum, probability) => sum + probability, 0);

  if (!(probabilitySum > 0)) {
    return null;
  }

  const normalizedProbabilities = probabilities.map((probability) => probability / probabilitySum);
  const fairOdds = normalizedProbabilities.map((probability) =>
    probability > 0 ? 1 / probability : null,
  );

  return {
    z: Number(z.toFixed(6)),
    probabilities: normalizedProbabilities.map((probability) =>
      Number(probability.toFixed(6)),
    ),
    fairOdds: fairOdds.map((price) => (price != null ? Number(price.toFixed(3)) : null)),
  };
}

function calculateValuePercentage(offeredPrice, fairPrice) {
  if (
    offeredPrice == null ||
    fairPrice == null ||
    !Number.isFinite(offeredPrice) ||
    !Number.isFinite(fairPrice) ||
    fairPrice <= 0
  ) {
    return null;
  }

  return Number((((offeredPrice / fairPrice) - 1) * 100).toFixed(2));
}

function normalizeComparableText(value) {
  return normalizeTeamName(value);
}

function compareField(leftValue, rightValue, { matchPoints, mismatchPenalty }) {
  const left = normalizeComparableText(leftValue);
  const right = normalizeComparableText(rightValue);

  if (!left || !right) {
    return 0;
  }

  return left === right ? matchPoints : mismatchPenalty;
}

function compareStartTimes(leftValue, rightValue) {
  const left = Number(leftValue);
  const right = Number(rightValue);

  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return 0;
  }

  const diffMs = Math.abs(left - right);

  if (diffMs <= 15 * 60 * 1000) {
    return 4;
  }

  if (diffMs <= 6 * 60 * 60 * 1000) {
    return 2;
  }

  if (diffMs <= 24 * 60 * 60 * 1000) {
    return 1;
  }

  return -4;
}

function scoreEventCandidate(leftEvent, rightEvent) {
  return (
    compareField(leftEvent.country, rightEvent.country, {
      matchPoints: 3,
      mismatchPenalty: -3,
    }) +
    compareField(leftEvent.league, rightEvent.league, {
      matchPoints: 5,
      mismatchPenalty: -5,
    }) +
    compareStartTimes(leftEvent.startTime, rightEvent.startTime)
  );
}

function selectBestCandidate(leftEvent, candidates, matchedRightIndexes) {
  const availableCandidates = candidates.filter(
    (candidate) => !matchedRightIndexes.has(candidate.index),
  );

  if (availableCandidates.length === 0) {
    return null;
  }

  if (availableCandidates.length === 1) {
    return availableCandidates[0];
  }

  let best = null;

  for (const candidate of availableCandidates) {
    const score = scoreEventCandidate(leftEvent, candidate.event);

    if (!best || score > best.score) {
      best = {
        ...candidate,
        score,
      };
    }
  }

  return best;
}

export function compareBooks({
  leftBookmaker,
  rightBookmaker,
  leftEvents,
  rightEvents,
}) {
  const rightEventsByKey = new Map();

  for (const [index, event] of rightEvents.entries()) {
    const normalizedKey = normalizeEventKey(event.key);
    const bucket = rightEventsByKey.get(normalizedKey) ?? [];
    bucket.push({ event, index });
    rightEventsByKey.set(normalizedKey, bucket);
  }

  const matchedRightIndexes = new Set();
  const matchedComparisons = [];
  const unmatchedLeftEvents = [];

  for (const leftEvent of leftEvents) {
    const normalizedKey = normalizeEventKey(leftEvent.key);
    const rightCandidates = rightEventsByKey.get(normalizedKey) ?? [];
    const bestCandidate = selectBestCandidate(leftEvent, rightCandidates, matchedRightIndexes);
    const rightEvent = bestCandidate?.event ?? null;

    if (!rightEvent) {
      unmatchedLeftEvents.push(leftEvent);
      continue;
    }

    matchedRightIndexes.add(bestCandidate.index);
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
    const shinMarket = calculateShinMarket(outcomes);
    const enrichedOutcomes = outcomes.map((outcome, index) => ({
      ...outcome,
      noVigPrice: shinMarket?.fairOdds[index] ?? null,
      noVigProbability: shinMarket?.probabilities[index] ?? null,
      valuePercentage: calculateValuePercentage(
        outcome.bestPrice,
        shinMarket?.fairOdds[index] ?? null,
      ),
    }));
    const bestBookmakerCount = outcomes.filter(
      (outcome) => outcome.bestBookmaker === leftBookmaker,
    ).length;
    const maxDeltaAbs = Number(
      Math.max(...outcomes.map((outcome) => Math.abs(outcome.delta ?? 0))).toFixed(3),
    );
    const maxValuePercentage = Number(
      Math.max(...enrichedOutcomes.map((outcome) => outcome.valuePercentage ?? Number.NEGATIVE_INFINITY)).toFixed(2),
    );

    matchedComparisons.push({
      key: leftEvent.key,
      country: leftEvent.country || rightEvent.country || null,
      league: leftEvent.league || rightEvent.league,
      startTime: leftEvent.startTime || rightEvent.startTime,
      bookmakers: [leftBookmaker, rightBookmaker],
      outcomes: enrichedOutcomes,
      maxDeltaAbs,
      maxValuePercentage: Number.isFinite(maxValuePercentage) ? maxValuePercentage : null,
      bestBookmakerCount,
      shinZ: shinMarket?.z ?? null,
      ...arbitrage,
    });
  }

  const unmatchedRightEvents = rightEvents.filter(
    (event, index) => !matchedRightIndexes.has(index),
  );

  return {
    comparisons: matchedComparisons.sort((a, b) => b.maxDeltaAbs - a.maxDeltaAbs),
    unmatchedLeftEvents,
    unmatchedRightEvents,
  };
}
