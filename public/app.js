const state = {
  search: "",
  country: "",
  league: "",
  sort: "edge",
  limit: "50",
};

const AUTO_REFRESH_MS = 45_000;
const ACTIVE_REFRESH_POLL_MS = 3_000;
const GOOGLE_NEWS_RECENCY = "when:7d";

const store = {
  snapshot: null,
  pollTimer: null,
  renderedRows: new Map(),
};

const el = {
  searchInput: document.querySelector("#search-input"),
  sortSelect: document.querySelector("#sort-select"),
  limitSelect: document.querySelector("#limit-select"),
  refreshButton: document.querySelector("#refresh-button"),
  resultsSummary: document.querySelector("#results-summary"),
  generatedAt: document.querySelector("#generated-at"),
  results: document.querySelector("#results"),
  template: document.querySelector("#match-row-template"),
  matchedEvents: document.querySelector("#matched-events"),
  arbCount: document.querySelector("#arb-count"),
  avgEdge: document.querySelector("#avg-edge"),
  countryTree: document.querySelector("#country-tree"),
  allButton: document.querySelector("#all-competitions-button"),
  selectionBar: document.querySelector("#selection-bar"),
  selectionKicker: document.querySelector("#selection-kicker"),
  selectionTitle: document.querySelector("#selection-title"),
  clearSelectionButton: document.querySelector("#clear-selection-button"),
};

function fmt(value) {
  return value == null ? "-" : Number(value).toFixed(3);
}

function calculateMarketPayout(prices) {
  const validPrices = prices.filter(
    (price) => price != null && Number.isFinite(Number(price)) && Number(price) > 1,
  );

  if (validPrices.length !== prices.length || validPrices.length === 0) {
    return null;
  }

  const bookPercentage = validPrices.reduce((sum, price) => sum + 1 / Number(price), 0) * 100;

  return {
    payoutPercentage: 10000 / bookPercentage,
    marginPercentage: bookPercentage - 100,
  };
}

function fmtPayout(value) {
  if (!value) {
    return "-";
  }

  return `${value.payoutPercentage.toFixed(2)}% (${value.marginPercentage.toFixed(2)}%)`;
}

function fmtKickoff(value) {
  if (!value) {
    return "TBD";
  }

  const date = new Date(value);
  const today = new Date();
  const isToday =
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return isToday
    ? time
    : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function buildGoogleNewsQuery(row) {
  const home = row.key?.home;
  const away = row.key?.away;
  const queries = [
    home && away ? `${home} vs ${away}` : "",
    home ? `${home} team news` : "",
    away ? `${away} team news` : "",
  ].filter(Boolean);

  return `${queries.join(" OR ")} ${GOOGLE_NEWS_RECENCY}`.trim();
}

function buildGoogleNewsUrl(row) {
  const url = new URL("https://news.google.com/search");
  url.searchParams.set("q", buildGoogleNewsQuery(row));
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");
  return url.toString();
}

function buildNewsApiUrl(row) {
  const url = new URL("/api/news", window.location.origin);
  url.searchParams.set("home", row.key?.home ?? "");
  url.searchParams.set("away", row.key?.away ?? "");
  return url.toString();
}

function fmtNewsTime(value) {
  if (!value) {
    return "";
  }

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const diffMs = new Date(value).getTime() - Date.now();
  const diffHours = Math.round(diffMs / (60 * 60 * 1000));

  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, "hour");
  }

  return formatter.format(Math.round(diffHours / 24), "day");
}

function renderNewsPanelBody(panel, content) {
  panel.querySelector(".news-panel__body").replaceChildren(content);
}

function renderNewsMessage(panel, message) {
  const messageEl = document.createElement("p");
  messageEl.className = "news-panel__message";
  messageEl.textContent = message;
  renderNewsPanelBody(panel, messageEl);
}

function renderNewsItems(panel, items) {
  if (!Array.isArray(items) || items.length === 0) {
    renderNewsMessage(panel, "No recent Google News coverage found from the last 7 days.");
    return;
  }

  const list = document.createElement("div");
  list.className = "news-panel__list";

  for (const item of items) {
    const article = document.createElement("a");
    article.className = "news-item";
    article.href = item.url;
    article.target = "_blank";
    article.rel = "noopener noreferrer";

    const title = document.createElement("strong");
    title.className = "news-item__title";
    title.textContent = item.title;

    const meta = document.createElement("span");
    meta.className = "news-item__meta";
    meta.textContent = [item.source, fmtNewsTime(item.publishedAt)].filter(Boolean).join(" · ");

    article.append(title, meta);
    list.append(article);
  }

  renderNewsPanelBody(panel, list);
}

async function loadNewsPanel(card, row) {
  const panel = card.querySelector(".news-panel");

  if (panel.dataset.loaded === "true") {
    return;
  }

  renderNewsMessage(panel, "Loading recent news...");

  try {
    const response = await fetch(buildNewsApiUrl(row));

    if (!response.ok) {
      throw new Error("Unable to load recent news.");
    }

    const data = await response.json();
    renderNewsItems(panel, data.items);
    panel.dataset.loaded = "true";
  } catch (error) {
    renderNewsMessage(
      panel,
      error instanceof Error ? error.message : "Unable to load recent news.",
    );
  }
}

function numericLimit(rawLimit) {
  if (rawLimit === "all") {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Number(rawLimit);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 50;
}

function getRowId(row) {
  return [
    row.key?.home ?? "",
    row.key?.away ?? "",
    row.country ?? "",
    row.league ?? "",
    row.startTime ?? "",
  ].join("::");
}

function getRowSignature(row) {
  return JSON.stringify({
    country: row.country ?? null,
    league: row.league ?? null,
    startTime: row.startTime ?? null,
    isArbitrage: row.isArbitrage ?? false,
    arbitrageMargin: row.arbitrageMargin ?? null,
    maxDeltaAbs: row.maxDeltaAbs ?? null,
    maxValuePercentage: row.maxValuePercentage ?? null,
    shinZ: row.shinZ ?? null,
    outcomes: Array.isArray(row.outcomes)
      ? row.outcomes.map((outcome) => ({
          label: outcome.label,
          leftPrice: outcome.leftPrice ?? null,
          rightPrice: outcome.rightPrice ?? null,
          bestPrice: outcome.bestPrice ?? null,
          noVigPrice: outcome.noVigPrice ?? null,
          noVigProbability: outcome.noVigProbability ?? null,
          valuePercentage: outcome.valuePercentage ?? null,
          hasChanged: outcome.hasChanged ?? false,
          changeFlags: outcome.changeFlags ?? null,
          bestBookmaker: outcome.bestBookmaker ?? null,
          delta: outcome.delta ?? null,
        }))
      : [],
  });
}

function matchesFilters(row) {
  const selectedCountry = state.country.trim().toLowerCase();
  const selectedLeague = state.league.trim().toLowerCase();
  const search = state.search.trim().toLowerCase();
  const haystack =
    `${row.key.home} ${row.key.away} ${row.league ?? ""} ${row.country ?? ""}`.toLowerCase();

  const matchesCountry =
    !selectedCountry || String(row.country ?? "").toLowerCase() === selectedCountry;
  const matchesLeague =
    !selectedLeague || String(row.league ?? "").toLowerCase() === selectedLeague;
  const matchesSearch = !search || haystack.includes(search);

  return matchesCountry && matchesLeague && matchesSearch;
}

function sortRows(rows) {
  const sorted = [...rows];

  if (state.sort === "start") {
    sorted.sort((left, right) => (left.startTime ?? 0) - (right.startTime ?? 0));
    return sorted;
  }

  if (state.sort === "arb") {
    sorted.sort((left, right) => {
      if (left.isArbitrage !== right.isArbitrage) {
        return left.isArbitrage ? -1 : 1;
      }

      return (left.arbitrageMargin ?? 999) - (right.arbitrageMargin ?? 999);
    });
    return sorted;
  }

  sorted.sort((left, right) => right.maxDeltaAbs - left.maxDeltaAbs);
  return sorted;
}

function buildCountryTree(rows) {
  const countries = new Map();

  for (const row of rows) {
    const countryName = row.country ?? "Other";
    const leagueName = row.league ?? "Unknown league";
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

function renderCountryTree(countries, selectedCountry, selectedLeague) {
  el.countryTree.replaceChildren();

  const fragment = document.createDocumentFragment();
  const countryList = Array.isArray(countries) ? countries : [];

  for (const country of countryList) {
    const details = document.createElement("details");
    details.className = "country-group";
    details.open =
      !selectedCountry ||
      selectedCountry === country.name ||
      (Array.isArray(country.leagues) &&
        country.leagues.some((league) => league.name === selectedLeague));

    const summary = document.createElement("summary");
    summary.className = "country-group__summary";

    const name = document.createElement("span");
    name.className = "country-group__name";
    name.textContent = country.name;

    const count = document.createElement("span");
    count.className = "country-group__count";
    count.textContent = country.count;

    summary.append(name, count);
    details.append(summary);

    const leagues = document.createElement("div");
    leagues.className = "country-group__leagues";

    for (const league of Array.isArray(country.leagues) ? country.leagues : []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        "league-link" +
        (selectedCountry === country.name && selectedLeague === league.name
          ? " league-link--active"
          : "");

      const leagueName = document.createElement("span");
      leagueName.className = "league-link__name";
      leagueName.textContent = league.name;

      const leagueCount = document.createElement("span");
      leagueCount.className = "league-link__count";
      leagueCount.textContent = league.count;

      button.append(leagueName, leagueCount);
      button.addEventListener("click", () => {
        state.country = country.name;
        state.league = league.name;
        applyFilters();
      });

      leagues.append(button);
    }

    details.append(leagues);

    summary.addEventListener("click", (event) => {
      if (event.target !== summary && !summary.contains(event.target)) {
        return;
      }

      if (selectedCountry === country.name && !selectedLeague) {
        state.country = "";
        state.league = "";
      } else {
        state.country = country.name;
        state.league = "";
      }

      setTimeout(() => {
        applyFilters();
      }, 0);
    });

    fragment.append(details);
  }

  el.countryTree.append(fragment);
  el.allButton.classList.toggle("is-active", !selectedCountry && !selectedLeague);
}

function renderSelectionBar(selectedCountry, selectedLeague, totalRows) {
  if (!selectedCountry && !selectedLeague) {
    el.selectionBar.hidden = true;
    return;
  }

  el.selectionBar.hidden = false;

  if (selectedLeague) {
    el.selectionKicker.textContent = selectedCountry ? `${selectedCountry} league` : "League";
    el.selectionTitle.textContent = `${selectedLeague} · ${totalRows} events`;
    return;
  }

  el.selectionKicker.textContent = "Country";
  el.selectionTitle.textContent = `${selectedCountry} · ${totalRows} events`;
}

function createMatchCard() {
  return el.template.content.firstElementChild.cloneNode(true);
}

function updateMatchCard(card, row, { highlight = false } = {}) {
  card.classList.toggle("match-row--arb", Boolean(row.isArbitrage));
  card.classList.toggle("match-row--updated", highlight);
  if (highlight) {
    clearTimeout(card._highlightTimer);
    card._highlightTimer = setTimeout(() => {
      card.classList.remove("match-row--updated");
    }, 1800);
  }

  card.querySelector(".match-row__time").textContent = fmtKickoff(row.startTime);
  card.querySelector(".match-row__teams").textContent = `${row.key.home} vs ${row.key.away}`;

  const countryButton = card.querySelector(".match-row__country");
  const leagueButton = card.querySelector(".match-row__league");

  countryButton.textContent = row.country ?? "";
  countryButton.hidden = !row.country;
  countryButton.onclick = () => {
    state.country = row.country ?? "";
    state.league = "";
    applyFilters();
  };

  leagueButton.textContent = row.league ?? "";
  leagueButton.hidden = !row.league;
  leagueButton.onclick = () => {
    state.country = row.country ?? "";
    state.league = row.league ?? "";
    applyFilters();
  };

  const newsLink = card.querySelector(".match-row__news");
  const newsPanel = card.querySelector(".news-panel");
  const googleNewsLink = card.querySelector(".news-panel__google");
  const newsCloseButton = card.querySelector(".news-panel__close");
  newsLink.title = `Show recent Google News for ${row.key.home} vs ${row.key.away}`;
  newsLink.setAttribute("aria-label", newsLink.title);
  googleNewsLink.href = buildGoogleNewsUrl(row);
  newsLink.onclick = () => {
    const isOpening = newsPanel.hidden;
    newsPanel.hidden = !isOpening;
    newsLink.classList.toggle("match-row__news--active", isOpening);
    newsLink.setAttribute("aria-expanded", String(isOpening));

    if (isOpening) {
      loadNewsPanel(card, row);
    }
  };
  newsCloseButton.onclick = () => {
    newsPanel.hidden = true;
    newsLink.classList.remove("match-row__news--active");
    newsLink.setAttribute("aria-expanded", "false");
  };

  const edgeBadge = card.querySelector(".badge--edge");
  if (row.maxDeltaAbs != null && row.maxDeltaAbs > 0) {
    edgeBadge.hidden = false;
    if (row.maxValuePercentage != null) {
      edgeBadge.textContent = `VALUE ${row.maxValuePercentage >= 0 ? "+" : ""}${row.maxValuePercentage.toFixed(2)}%`;
    } else {
      edgeBadge.textContent =
        row.shinZ != null ? `EDGE +${fmt(row.maxDeltaAbs)} · Z ${fmt(row.shinZ)}` : `EDGE +${fmt(row.maxDeltaAbs)}`;
    }
  } else {
    edgeBadge.hidden = row.shinZ == null;
    edgeBadge.textContent = row.shinZ != null ? `SHIN Z ${fmt(row.shinZ)}` : "";
  }

  const arbBadge = card.querySelector(".badge--arb");
  if (row.isArbitrage) {
    arbBadge.hidden = false;
    arbBadge.textContent =
      row.arbitrageMargin != null ? `ARB ${row.arbitrageMargin}%` : "ARB";
  } else {
    arbBadge.hidden = true;
    arbBadge.textContent = "ARB";
  }

  const tbody = card.querySelector("tbody");
  tbody.replaceChildren();

  const merkurPayout = calculateMarketPayout(
    row.outcomes.map((outcome) => outcome.leftPrice),
  );
  const pinnaclePayout = calculateMarketPayout(
    row.outcomes.map((outcome) => outcome.rightPrice),
  );

  for (const outcome of row.outcomes) {
    const tr = document.createElement("tr");

    if (row.isArbitrage) {
      tr.classList.add("row--arb-outcome");
    }

    const merkurBest = outcome.bestBookmaker === "MerkurXTip";
    const pinnacleBest = outcome.bestBookmaker === "Pinnacle";
    const delta = outcome.delta;
    const valuePercentage = outcome.valuePercentage;
    const changeFlags = outcome.changeFlags ?? {};

    let deltaClass = "cell--delta-zero";
    let deltaText = "-";
    let valueClass = "cell--value-zero";
    let valueText = "-";

    if (delta != null) {
      deltaClass =
        delta > 0 ? "cell--delta-pos" : delta < 0 ? "cell--delta-neg" : "cell--delta-zero";
      deltaText = `${delta >= 0 ? "+" : ""}${fmt(delta)}`;
    }

    if (valuePercentage != null) {
      valueClass =
        valuePercentage > 0
          ? "cell--value-pos"
          : valuePercentage < 0
            ? "cell--value-neg"
            : "cell--value-zero";
      valueText = `${valuePercentage >= 0 ? "+" : ""}${valuePercentage.toFixed(2)}%`;
    }

    const labelMap = { "1": "HOME", X: "DRAW", "2": "AWAY" };
    const label = labelMap[outcome.label] ?? outcome.label;
    const leftClass = [merkurBest ? "cell--best-left" : "", changeFlags.leftPrice ? "cell--updated" : ""]
      .filter(Boolean)
      .join(" ");
    const rightClass = [pinnacleBest ? "cell--best-right" : "", changeFlags.rightPrice ? "cell--updated" : ""]
      .filter(Boolean)
      .join(" ");
    const bestClass = ["cell--best-price", changeFlags.bestPrice ? "cell--updated" : ""]
      .filter(Boolean)
      .join(" ");
    const noVigClass = ["cell--no-vig", changeFlags.noVigPrice ? "cell--updated" : ""]
      .filter(Boolean)
      .join(" ");
    const valueCellClass = [valueClass, changeFlags.valuePercentage ? "cell--updated" : ""]
      .filter(Boolean)
      .join(" ");
    const deltaCellClass = [deltaClass, changeFlags.delta ? "cell--updated" : ""]
      .filter(Boolean)
      .join(" ");

    tr.innerHTML = `
      <td>${label}</td>
      <td class="${leftClass}">${fmt(outcome.leftPrice)}</td>
      <td class="${rightClass}">${fmt(outcome.rightPrice)}</td>
      <td class="${bestClass}">${outcome.bestPrice != null ? fmt(outcome.bestPrice) : "-"}</td>
      <td class="${noVigClass}">${outcome.noVigPrice != null ? fmt(outcome.noVigPrice) : "-"}</td>
      <td class="${valueCellClass}">${valueText}</td>
      <td class="${deltaCellClass}">${deltaText}</td>
    `;

    tbody.append(tr);
  }

  const payoutRow = document.createElement("tr");
  payoutRow.className = "row--payout";
  payoutRow.innerHTML = `
    <td>PAYOUT</td>
    <td>${fmtPayout(merkurPayout)}</td>
    <td>${fmtPayout(pinnaclePayout)}</td>
    <td colspan="4"></td>
  `;
  tbody.append(payoutRow);
}

function renderRows(rows, { incremental = false } = {}) {
  if (rows.length === 0) {
    store.renderedRows.clear();
    el.results.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No matches fit the current filters.";
    el.results.append(empty);
    return;
  }

  const nextRenderedRows = new Map();
  const fragment = document.createDocumentFragment();

  for (const row of rows) {
    const rowId = getRowId(row);
    const signature = getRowSignature(row);
    const existing = incremental ? store.renderedRows.get(rowId) : null;
    const card = existing?.card ?? createMatchCard();
    const hasChanged = !existing || existing.signature !== signature;

    if (hasChanged) {
      updateMatchCard(card, row, {
        highlight: incremental && Boolean(existing),
      });
    }

    nextRenderedRows.set(rowId, { card, signature });
    fragment.append(card);
  }

  store.renderedRows = nextRenderedRows;
  el.results.replaceChildren(fragment);
}

function scheduleProgressPolling() {
  clearTimeout(store.pollTimer);

  const delay = store.snapshot?.progress?.isRefreshing
    ? ACTIVE_REFRESH_POLL_MS
    : AUTO_REFRESH_MS;

  store.pollTimer = setTimeout(() => {
    fetchSnapshot({ silent: true, incremental: true }).catch((error) => {
      el.resultsSummary.textContent = error.message;
      scheduleProgressPolling();
    });
  }, delay);
}

function buildProgressText(progress) {
  const loaded = Number(progress?.loadedLeagueCount ?? 0);
  const total = Number(progress?.totalLeagueCount ?? 0);

  if (total <= 0) {
    return "";
  }

  if (progress?.isRefreshing) {
    return `Loading leagues ${loaded}/${total}...`;
  }

  if (progress?.isPartial) {
    return `Showing partial data ${loaded}/${total} leagues loaded.`;
  }

  return `Loaded ${loaded}/${total} leagues.`;
}

function renderSnapshot(projected, { incremental = false } = {}) {
  const counts = projected.counts ?? {};
  const summary = projected.summary ?? {};
  const rows = Array.isArray(projected.rows) ? projected.rows : [];
  const countries = Array.isArray(projected.countries) ? projected.countries : [];
  const progress = projected.progress ?? {};
  const progressText = buildProgressText(progress);

  el.matchedEvents.textContent = counts.matchedEvents ?? 0;
  el.arbCount.textContent = summary.arbitrageCount ?? 0;
  el.avgEdge.textContent = Number(summary.averageEdge ?? 0).toFixed(3);
  el.resultsSummary.textContent = progressText
    ? `Showing ${rows.length} of ${projected.totalRows ?? rows.length} matches · ${summary.leagueCount ?? 0} leagues · ${progressText}`
    : `Showing ${rows.length} of ${projected.totalRows ?? rows.length} matches · ${summary.leagueCount ?? 0} leagues`;
  el.generatedAt.textContent = `Updated ${new Date(projected.generatedAt).toLocaleTimeString()}`;

  renderCountryTree(countries, state.country, state.league);
  renderSelectionBar(state.country, state.league, projected.totalRows ?? rows.length);
  renderRows(rows, { incremental });
  scheduleProgressPolling();
}

function applyFilters({ incremental = false } = {}) {
  if (!store.snapshot) {
    return;
  }

  const filteredRows = sortRows(
    (Array.isArray(store.snapshot.comparisons) ? store.snapshot.comparisons : []).filter(
      matchesFilters,
    ),
  );
  const visibleRows = filteredRows.slice(0, numericLimit(state.limit));

  renderSnapshot({
    generatedAt: store.snapshot.generatedAt,
    counts: store.snapshot.counts,
    summary: store.snapshot.summary,
    progress: store.snapshot.progress,
    rows: visibleRows,
    totalRows: filteredRows.length,
    countries: buildCountryTree(filteredRows),
  }, { incremental });
}

async function fetchSnapshot({ silent = false, incremental = false } = {}) {
  if (!silent) {
    el.resultsSummary.textContent = "Loading...";
  }

  const response = await fetch("/api/comparisons?limit=all");

  if (!response.ok) {
    throw new Error("Failed to fetch comparison feed.");
  }

  const data = await response.json();
  store.snapshot = {
    generatedAt: data.generatedAt,
    counts: data.counts ?? {},
    summary: data.summary ?? {},
    progress: data.progress ?? {},
    comparisons: Array.isArray(data.rows) ? data.rows : [],
  };

  applyFilters({ incremental });
}

async function refreshFeed() {
  el.refreshButton.disabled = true;
  el.refreshButton.querySelector("svg").style.animation = "spin 0.8s linear infinite";

  try {
    await fetch("/api/refresh", { method: "POST" });
    await fetchSnapshot();
  } finally {
    el.refreshButton.disabled = false;
    el.refreshButton.querySelector("svg").style.animation = "";
  }
}

let pendingTimer = null;

function queueLoad() {
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    applyFilters();
  }, 180);
}

el.searchInput.addEventListener("input", (event) => {
  state.search = event.target.value;
  queueLoad();
});

el.sortSelect.addEventListener("change", (event) => {
  state.sort = event.target.value;
  applyFilters();
});

el.limitSelect.addEventListener("change", (event) => {
  state.limit = event.target.value;
  applyFilters();
});

el.refreshButton.addEventListener("click", () => {
  refreshFeed().catch((error) => {
    el.resultsSummary.textContent = error.message;
    el.refreshButton.disabled = false;
    el.refreshButton.querySelector("svg").style.animation = "";
  });
});

el.allButton.addEventListener("click", () => {
  state.country = "";
  state.league = "";
  applyFilters();
});

el.clearSelectionButton.addEventListener("click", () => {
  state.country = "";
  state.league = "";
  applyFilters();
});

fetchSnapshot().catch((error) => {
  el.resultsSummary.textContent = error.message;
});
