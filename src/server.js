import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initializeAdminSchema,
  checkAdminDatabase,
  listAdminReviewData,
  listAdminMappingData,
  mapUnmatchedLeague,
  ignoreUnmatchedLeague,
  mapUnmatchedEvent,
  ignoreUnmatchedEvent,
  createLeagueMapping,
  createTeamMapping,
  unmapLeagueMapping,
  unmapTeamMapping,
} from "./db/admin-repository.js";
import { getTursoConfigStatus } from "./db/turso.js";
import {
  getComparisonData,
  projectComparisonData,
  warmComparisonCache,
} from "./services/comparison-service.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3000);
const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
  });
  response.end(message);
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function getSafeAssetPath(requestPathname) {
  const requestedPath = requestPathname === "/" ? "/index.html" : requestPathname;
  const safePath = normalize(requestedPath)
    .replace(/^[/\\]+/, "")
    .replace(/^(\.\.[/\\])+/, "");
  return join(publicRoot, safePath);
}

async function serveStaticAsset(requestPathname, response) {
  const assetPath = getSafeAssetPath(requestPathname);

  if (!assetPath.startsWith(publicRoot)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const file = await readFile(assetPath);
    const contentType = CONTENT_TYPES[extname(assetPath)] ?? "application/octet-stream";

    response.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store",
    });
    response.end(file);
  } catch {
    sendText(response, 404, "Not found");
  }
}

function parseQuery(url) {
  return {
    limit: url.searchParams.get("limit"),
    search: url.searchParams.get("search") ?? "",
    country: url.searchParams.get("country") ?? "",
    league: url.searchParams.get("league") ?? "",
    sort: url.searchParams.get("sort") ?? "edge",
  };
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `${HOST}:${PORT}`}`);

  if (requestUrl.pathname === "/api/comparisons") {
    try {
      const filters = parseQuery(requestUrl);
      const data = await getComparisonData();
      const projected = projectComparisonData(data, filters);
      sendJson(response, 200, projected);
    } catch (error) {
      sendJson(response, 500, {
        error: "Unable to load comparisons.",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (requestUrl.pathname === "/api/refresh" && request.method === "POST") {
    try {
      const data = await getComparisonData({ forceRefresh: true });
      sendJson(response, 200, {
        ok: true,
        refreshedAt: data.generatedAt,
      });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (requestUrl.pathname === "/api/admin/status") {
    try {
      const config = getTursoConfigStatus();
      sendJson(response, 200, {
        ok: true,
        config,
      });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (requestUrl.pathname === "/api/admin/db-check" && request.method === "POST") {
    try {
      const result = await checkAdminDatabase();
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (requestUrl.pathname === "/api/admin/db-init" && request.method === "POST") {
    try {
      const result = await initializeAdminSchema();
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (requestUrl.pathname === "/api/admin/review" && request.method === "GET") {
    try {
      const review = await listAdminReviewData();
      const comparisonData = await getComparisonData();
      sendJson(response, 200, {
        ok: true,
        coverage: comparisonData.coverage ?? null,
        ...review,
      });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (requestUrl.pathname === "/api/admin/mappings" && request.method === "GET") {
    try {
      const [mappings, comparisonData] = await Promise.all([
        listAdminMappingData(),
        getComparisonData().catch(() => null),
      ]);
      sendJson(response, 200, {
        ok: true,
        ...mappings,
        sourceTeamOptions:
          comparisonData?.sourceTeamOptions?.length > 0
            ? comparisonData.sourceTeamOptions
            : mappings.sourceTeamOptions,
      });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (requestUrl.pathname === "/api/admin/league-mappings" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const result = await createLeagueMapping({
        bookmakerSlug: body.bookmakerSlug,
        sourceCountryName: body.sourceCountryName,
        sourceLeagueName: body.sourceLeagueName,
        canonicalCountryName: body.canonicalCountryName,
        canonicalLeagueName: body.canonicalLeagueName,
      });
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (requestUrl.pathname === "/api/admin/team-mappings" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const result = await createTeamMapping({
        bookmakerSlug: body.bookmakerSlug,
        sourceTeamName: body.sourceTeamName,
        canonicalCountryName: body.canonicalCountryName,
        canonicalTeamName: body.canonicalTeamName,
      });
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const leagueMapMatch = requestUrl.pathname.match(/^\/api\/admin\/unmatched-leagues\/(\d+)\/map$/);
  if (leagueMapMatch && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const result = await mapUnmatchedLeague({
        unmatchedLeagueId: Number(leagueMapMatch[1]),
        canonicalCountryName: body.canonicalCountryName,
        canonicalLeagueName: body.canonicalLeagueName,
      });
      sendJson(response, 200, result);
    } catch (error) {
      console.error("[league-mappings]", error);
      sendJson(response, 500, {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const leagueIgnoreMatch = requestUrl.pathname.match(/^\/api\/admin\/unmatched-leagues\/(\d+)\/ignore$/);
  if (leagueIgnoreMatch && request.method === "POST") {
    try {
      const result = await ignoreUnmatchedLeague(Number(leagueIgnoreMatch[1]));
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const eventMapMatch = requestUrl.pathname.match(/^\/api\/admin\/unmatched-events\/(\d+)\/map$/);
  if (eventMapMatch && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const result = await mapUnmatchedEvent({
        unmatchedEventId: Number(eventMapMatch[1]),
        canonicalCountryName: body.canonicalCountryName,
        canonicalHomeName: body.canonicalHomeName,
        canonicalAwayName: body.canonicalAwayName,
      });
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const eventIgnoreMatch = requestUrl.pathname.match(/^\/api\/admin\/unmatched-events\/(\d+)\/ignore$/);
  if (eventIgnoreMatch && request.method === "POST") {
    try {
      const result = await ignoreUnmatchedEvent(Number(eventIgnoreMatch[1]));
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const leagueUnmapMatch = requestUrl.pathname.match(/^\/api\/admin\/league-mappings\/(\d+)\/unmap$/);
  if (leagueUnmapMatch && request.method === "POST") {
    try {
      const result = await unmapLeagueMapping(Number(leagueUnmapMatch[1]));
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const teamUnmapMatch = requestUrl.pathname.match(/^\/api\/admin\/team-mappings\/(\d+)\/unmap$/);
  if (teamUnmapMatch && request.method === "POST") {
    try {
      const result = await unmapTeamMapping(Number(teamUnmapMatch[1]));
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  await serveStaticAsset(requestUrl.pathname, response);
});

server.listen(PORT, HOST, () => {
  console.log(`BetTool web app running at http://${HOST}:${PORT}`);
  warmComparisonCache();
});
