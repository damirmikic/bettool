const state = {
  search: "",
  country: "",
  league: "",
  sort: "recent",
  limit: "50",
};

const AUTO_REFRESH_MS = 45_000;
const ACTIVE_REFRESH_POLL_MS = 3_000;

const store = {
  snapshot: null,
  pollTimer: null,
};

const el = {
  searchInput: document.querySelector("#changes-search-input"),
  sortSelect: document.querySelector("#changes-sort-select"),
  limitSelect: document.querySelector("#changes-limit-select"),
  refreshButton: document.querySelector("#changes-refresh-button"),
  resultsSummary: document.querySelector("#changes-results-summary"),
  generatedAt: document.querySelector("#changes-generated-at"),
  results: document.querySelector("#changes-results"),
  template: document.querySelector("#changes-card-template"),
  matchCount: document.querySelector("#changes-match-count"),
  outcomeCount: document.querySelector("#changes-outcome-count"),
  countryTree: document.querySelector("#changes-country-tree"),
  allButton: document.querySelector("#changes-all-button"),
  selectionBar: document.querySelector("#changes-selection-bar"),
  selectionKicker: document.querySelector("#changes-selection-kicker"),
  selectionTitle: document.querySelector("#changes-selection-title"),
  clearSelectionButton: document.querySelector("#changes-clear-selection-button"),
};

function fmt(value) {
  return value == null ? "-" : Number(value).toFixed(3);
}

function fmtPct(value) {
  return value == null ? "-" : `${value >= 0 ? "+" : ""}${Number(value).toFixed(2)}%`;
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

function labelForOutcome(label) {
  return { "1": "HOME", X: "DRAW", "2": "AWAY" }[label] ?? label;
}

function normalizeRows(rows) {
  return rows
    .map((row) => {
      const changedOutcomes = (Array.isArray(row.outcomes) ? row.outcomes : []).filter(
        (outcome) => outcome.hasChanged,
      );

      if (changedOutcomes.length === 0) {
        return null;
      }

      return {
        ...row,
        changedOutcomes,
      };
    })
    .filter(Boolean);
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

  sorted.sort((left, right) => (right.changedOutcomeCount ?? 0) - (left.changedOutcomeCount ?? 0));
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

  for (const country of countries) {
    const details = document.createElement("details");
    details.className = "country-group";
    details.open =
      !selectedCountry ||
      selectedCountry === country.name ||
      country.leagues.some((league) => league.name === selectedLeague);

    const summary = document.createElement("summary");
    summary.className = "country-group__summary";
    summary.innerHTML = `
      <span class="country-group__name">${country.name}</span>
      <span class="country-group__count">${country.count}</span>
    `;
    details.append(summary);

    const leagues = document.createElement("div");
    leagues.className = "country-group__leagues";

    for (const league of country.leagues) {
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        "league-link" +
        (selectedCountry === country.name && selectedLeague === league.name
          ? " league-link--active"
          : "");
      button.innerHTML = `
        <span class="league-link__name">${league.name}</span>
        <span class="league-link__count">${league.count}</span>
      `;
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
    el.selectionTitle.textContent = `${selectedLeague} · ${totalRows} matches`;
    return;
  }

  el.selectionKicker.textContent = "Country";
  el.selectionTitle.textContent = `${selectedCountry} · ${totalRows} matches`;
}

function renderRows(rows) {
  el.results.replaceChildren();

  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No changed odds fit the current filters.";
    el.results.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const row of rows) {
    const card = el.template.content.firstElementChild.cloneNode(true);
    card.querySelector(".value-card__time").textContent = fmtKickoff(row.startTime);
    card.querySelector(".value-card__teams").textContent = `${row.key.home} vs ${row.key.away}`;
    card.querySelector(".changes-card__badge").textContent = `${row.changedOutcomeCount} changed`;

    const countryButton = card.querySelector(".changes-card__country");
    countryButton.textContent = row.country ?? "";
    countryButton.hidden = !row.country;
    countryButton.onclick = () => {
      state.country = row.country ?? "";
      state.league = "";
      applyFilters();
    };

    const leagueButton = card.querySelector(".changes-card__league");
    leagueButton.textContent = row.league ?? "";
    leagueButton.hidden = !row.league;
    leagueButton.onclick = () => {
      state.country = row.country ?? "";
      state.league = row.league ?? "";
      applyFilters();
    };

    const tbody = card.querySelector("tbody");

    for (const outcome of row.changedOutcomes) {
      const tr = document.createElement("tr");

      tr.innerHTML = `
        <td>${labelForOutcome(outcome.label)}</td>
        <td>${fmt(outcome.previousState?.leftPrice)} → ${fmt(outcome.leftPrice)}</td>
        <td>${fmt(outcome.previousState?.rightPrice)} → ${fmt(outcome.rightPrice)}</td>
        <td>${fmt(outcome.previousState?.bestPrice)} → ${fmt(outcome.bestPrice)}</td>
        <td>${fmt(outcome.previousState?.noVigPrice)} → ${fmt(outcome.noVigPrice)}</td>
        <td class="${outcome.valuePercentage > 0 ? "cell--value-pos" : outcome.valuePercentage < 0 ? "cell--value-neg" : "cell--value-zero"}">${fmtPct(outcome.previousState?.valuePercentage)} → ${fmtPct(outcome.valuePercentage)}</td>
      `;

      tbody.append(tr);
    }

    fragment.append(card);
  }

  el.results.append(fragment);
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

function scheduleProgressPolling() {
  clearTimeout(store.pollTimer);

  const delay = store.snapshot?.progress?.isRefreshing
    ? ACTIVE_REFRESH_POLL_MS
    : AUTO_REFRESH_MS;

  store.pollTimer = setTimeout(() => {
    fetchSnapshot({ silent: true }).catch((error) => {
      el.resultsSummary.textContent = error.message;
      scheduleProgressPolling();
    });
  }, delay);
}

function applyFilters() {
  if (!store.snapshot) {
    return;
  }

  const rows = normalizeRows(store.snapshot.rows ?? []);
  const filteredRows = sortRows(rows.filter(matchesFilters));
  const visibleRows = filteredRows.slice(0, numericLimit(state.limit));
  const changedOutcomeCount = filteredRows.reduce(
    (sum, row) => sum + (row.changedOutcomeCount ?? 0),
    0,
  );
  const progressText = buildProgressText(store.snapshot.progress);

  el.matchCount.textContent = filteredRows.length;
  el.outcomeCount.textContent = changedOutcomeCount;
  el.resultsSummary.textContent = progressText
    ? `Showing ${visibleRows.length} of ${filteredRows.length} changed matches · ${changedOutcomeCount} outcomes · ${progressText}`
    : `Showing ${visibleRows.length} of ${filteredRows.length} changed matches · ${changedOutcomeCount} outcomes`;
  el.generatedAt.textContent = `Updated ${new Date(store.snapshot.generatedAt).toLocaleTimeString()}`;

  renderCountryTree(buildCountryTree(filteredRows), state.country, state.league);
  renderSelectionBar(state.country, state.league, filteredRows.length);
  renderRows(visibleRows);
  scheduleProgressPolling();
}

async function fetchSnapshot({ silent = false } = {}) {
  if (!silent) {
    el.resultsSummary.textContent = "Loading...";
  }

  const response = await fetch("/api/comparisons?limit=all");

  if (!response.ok) {
    throw new Error("Failed to fetch changes feed.");
  }

  const data = await response.json();
  store.snapshot = {
    generatedAt: data.generatedAt,
    progress: data.progress ?? {},
    rows: Array.isArray(data.changes?.rows) ? data.changes.rows : [],
  };

  applyFilters();
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
