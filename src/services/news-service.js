const RECENT_NEWS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NEWS_ITEMS = 5;
const RECENCY_OPERATOR = "when:7d";

function decodeXmlEntities(value) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .trim();
}

function getXmlTag(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? decodeXmlEntities(match[1]) : "";
}

function getSource(block) {
  const source = getXmlTag(block, "source");
  return source || "Google News";
}

function parseRssItems(xml) {
  const itemBlocks = String(xml).match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  const cutoff = Date.now() - RECENT_NEWS_WINDOW_MS;

  return itemBlocks
    .map((block) => {
      const publishedAt = getXmlTag(block, "pubDate");
      const publishedTime = Date.parse(publishedAt);

      return {
        title: getXmlTag(block, "title"),
        url: getXmlTag(block, "link"),
        source: getSource(block),
        publishedAt: Number.isFinite(publishedTime) ? new Date(publishedTime).toISOString() : null,
        publishedTime,
      };
    })
    .filter((item) => item.title && item.url)
    .filter((item) => Number.isFinite(item.publishedTime) && item.publishedTime >= cutoff)
    .sort((left, right) => right.publishedTime - left.publishedTime);
}

function buildGoogleNewsRssUrl(query) {
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", query);
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");
  return url;
}

async function fetchRecentNewsQuery(query) {
  const cleanQuery = String(query ?? "").trim();

  if (!cleanQuery) {
    return [];
  }

  const rssUrl = buildGoogleNewsRssUrl(cleanQuery);
  const response = await fetch(rssUrl, {
    headers: {
      accept: "application/rss+xml, application/xml, text/xml, */*",
      "user-agent": "Mozilla/5.0 BetTool/0.1",
    },
  });

  if (!response.ok) {
    throw new Error(`Google News request failed: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();

  return parseRssItems(xml);
}

function normalizeNewsKey(item) {
  return String(item.title ?? "")
    .replace(/\s+-\s+[^-]+$/u, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeNewsItems(items) {
  const seen = new Set();
  const deduped = [];

  for (const item of items) {
    const key = normalizeNewsKey(item) || item.url;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

export async function fetchRecentNews(query) {
  const cleanQuery = String(query ?? "").trim();
  const items = await fetchRecentNewsQuery(cleanQuery);

  return {
    query: cleanQuery,
    queries: cleanQuery ? [cleanQuery] : [],
    items: dedupeNewsItems(items)
      .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
      .slice(0, MAX_NEWS_ITEMS)
      .map(({ publishedTime, ...item }) => item),
  };
}

export async function fetchRecentEventNews({ home, away }) {
  const cleanHome = String(home ?? "").trim();
  const cleanAway = String(away ?? "").trim();
  const matchup = [cleanHome, cleanAway].filter(Boolean).join(" vs ");
  const queries = [
    matchup ? `${matchup} ${RECENCY_OPERATOR}` : "",
    cleanHome ? `${cleanHome} team news ${RECENCY_OPERATOR}` : "",
    cleanAway ? `${cleanAway} team news ${RECENCY_OPERATOR}` : "",
  ].filter(Boolean);

  if (queries.length === 0) {
    return {
      query: "",
      queries,
      items: [],
    };
  }

  const queryResults = await Promise.all(queries.map((query) => fetchRecentNewsQuery(query)));
  const items = dedupeNewsItems(queryResults.flat())
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
    .slice(0, MAX_NEWS_ITEMS)
    .map(({ publishedTime, ...item }) => item);

  return {
    query: queries.join(" | "),
    queries,
    items,
  };
}
