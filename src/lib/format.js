function renderPrice(value) {
  return value == null ? "-" : value.toFixed(3);
}

function renderStartTime(value) {
  if (typeof value !== "number") {
    return value ?? "Unknown start";
  }

  return new Date(value).toISOString();
}

export function formatComparisonTable(comparisons) {
  if (comparisons.length === 0) {
    return "No overlapping events with comparable 1X2 odds were found.";
  }

  const lines = [];

  for (const comparison of comparisons) {
    lines.push(
      `${comparison.key.home} vs ${comparison.key.away} | ${comparison.league ?? "Unknown league"} | ${renderStartTime(comparison.startTime)}`,
    );
    if (comparison.isArbitrage) {
      lines.push(
        `  Arb: YES | Margin=${renderPrice(comparison.arbitrageMargin)} | Payout=${renderPrice(comparison.payoutRate)}`,
      );
    }

    for (const outcome of comparison.outcomes) {
      lines.push(
        `  ${outcome.label}: MerkurXTip=${renderPrice(outcome.leftPrice)} Pinnacle=${renderPrice(outcome.rightPrice)} Best=${outcome.bestBookmaker} Delta=${renderPrice(outcome.delta)}`,
      );
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
