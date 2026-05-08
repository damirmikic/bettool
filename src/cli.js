import { getComparisonData } from "./services/comparison-service.js";
import { formatComparisonTable } from "./lib/format.js";

function parseLimitArg(argv) {
  const limitArg = argv.find((arg) => arg.startsWith("--limit="));

  if (!limitArg) {
    return 25;
  }

  const rawValue = limitArg.slice("--limit=".length);

  if (rawValue === "all") {
    return Number.POSITIVE_INFINITY;
  }

  const value = Number(rawValue);
  return Number.isInteger(value) && value > 0 ? value : 25;
}

async function main() {
  try {
    const data = await getComparisonData();
    const limit = parseLimitArg(process.argv.slice(2));
    const visibleRows = data.comparisons.slice(0, limit);

    console.log(`MerkurXTip events: ${data.counts.merkurEvents}`);
    console.log(`Pinnacle events: ${data.counts.pinnacleEvents}`);
    console.log(`Matched events: ${data.counts.matchedEvents}`);
    console.log(`Potential arbs: ${data.summary.arbitrageCount}`);
    console.log(
      `Showing: ${Number.isFinite(limit) ? visibleRows.length : data.comparisons.length}`,
    );
    console.log("");
    console.log(formatComparisonTable(visibleRows));
  } catch (error) {
    console.error("Comparison failed.");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

await main();
