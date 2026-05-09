const state = {
  search: "",
  country: "",
  league: "",
  sort: "edge",
  limit: "50",
};

const AUTO_REFRESH_MS = 45_000;
const ACTIVE_REFRESH_POLL_MS = 3_000;

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
