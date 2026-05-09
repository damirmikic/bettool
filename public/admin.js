const elements = {
  refreshButton: document.querySelector("#admin-refresh-button"),
  leagueCount: document.querySelector("#admin-league-count"),
  eventCount: document.querySelector("#admin-event-count"),
  dbStatus: document.querySelector("#admin-db-status"),
  merkurLeagues: document.querySelector("#coverage-merkur-leagues"),
  merkurMatches: document.querySelector("#coverage-merkur-matches"),
  pinnacleLeagues: document.querySelector("#coverage-pinnacle-leagues"),
  pinnacleMatches: document.querySelector("#coverage-pinnacle-matches"),
  comparableLeagues: document.querySelector("#coverage-comparable-leagues"),
  comparableMatches: document.querySelector("#coverage-comparable-matches"),
  message: document.querySelector("#admin-message"),
  leagues: document.querySelector("#unmatched-leagues"),
  events: document.querySelector("#unmatched-events"),
  mappedLeagues: document.querySelector("#mapped-leagues"),
  mappedTeams: document.querySelector("#mapped-teams"),
  leagueMappingForm: document.querySelector("#league-mapping-form"),
  teamMappingForm: document.querySelector("#team-mapping-form"),
  teamLeagueFilter: document.querySelector("#team-league-filter"),
  tabs: Array.from(document.querySelectorAll(".admin-tab")),
  panels: Array.from(document.querySelectorAll(".admin-panel")),
  leagueTemplate: document.querySelector("#admin-league-template"),
  eventTemplate: document.querySelector("#admin-event-template"),
  mappedLeagueTemplate: document.querySelector("#admin-mapped-league-template"),
  mappedTeamTemplate: document.querySelector("#admin-mapped-team-template"),
};

const state = {
  sourceLeagueOptions: [],
  sourceTeamOptions: [],
  canonicalLeagueOptions: [],
  canonicalTeamOptions: [],
  mappedLeagues: [],
};

function pct(value) {
  return `${Math.round(Number(value ?? 0) * 100)}%`;
}

function leagueSourceKey(option) {
  return JSON.stringify({
    bookmakerSlug: option.bookmaker_slug ?? "",
    sourceCountryName: option.source_country_name ?? "",
    sourceLeagueName: option.source_league_name ?? "",
  });
}

function normalizeAdminText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function simplifyLeagueName(countryName, leagueName) {
  const country = String(countryName ?? "").trim();
  const league = String(leagueName ?? "").trim();

  if (!country || !league) {
    return league;
  }

  const normalizedCountry = normalizeAdminText(country);
  const normalizedLeague = normalizeAdminText(league);

  if (normalizedCountry && normalizedLeague === normalizedCountry) {
    return league;
  }

  const separators = [" - ", " — ", " | ", ": "];

  for (const separator of separators) {
    const prefix = `${country}${separator}`;
    if (league.toLowerCase().startsWith(prefix.toLowerCase())) {
      return league.slice(prefix.length).trim() || league;
    }
  }

  return league;
}

function splitCompoundLeagueName(value) {
  const text = String(value ?? "").trim();
  const separators = [" - ", " — ", " | ", ": "];

  for (const separator of separators) {
    const index = text.indexOf(separator);
    if (index > 0) {
      return {
        countryName: text.slice(0, index).trim(),
        leagueName: text.slice(index + separator.length).trim(),
      };
    }
  }

  return null;
}

function inferCountryFromLeagueName(leagueName) {
  const split = splitCompoundLeagueName(leagueName);
  return split?.countryName ?? "";
}

function autoFillCanonicalCountry({ fallbackCountryName = "" } = {}) {
  const form = elements.leagueMappingForm;
  const countryInput = form.elements.canonicalCountryName;
  const leagueName = form.elements.canonicalLeagueName.value.trim();
  const inferredCountryName = inferCountryFromLeagueName(leagueName) || fallbackCountryName || "";
  const previousAutoValue = countryInput.dataset.autoValue ?? "";
  const canUpdate =
    !countryInput.value.trim() ||
    (previousAutoValue && countryInput.value.trim() === previousAutoValue);

  if (!inferredCountryName || !canUpdate) {
    return;
  }

  countryInput.value = inferredCountryName;
  countryInput.dataset.autoValue = inferredCountryName;
}

function leagueDisplayParts(option) {
  const sourceCountryName = String(option.source_country_name ?? "").trim();
  const sourceLeagueName = String(option.source_league_name ?? "").trim();

  if (
    sourceCountryName &&
    sourceLeagueName &&
    normalizeAdminText(sourceCountryName) === normalizeAdminText(sourceLeagueName)
  ) {
    const split = splitCompoundLeagueName(sourceLeagueName);

    if (split?.countryName && split?.leagueName) {
      return split;
    }
  }

  return {
    countryName: sourceCountryName || "Unknown country",
    leagueName: simplifyLeagueName(sourceCountryName, sourceLeagueName),
  };
}

function leagueDisplayLabel(option) {
  const { countryName, leagueName } = leagueDisplayParts(option);

  return `${countryName} | ${leagueName}`;
}

function leagueLogicalKey(option) {
  const { countryName, leagueName } = leagueDisplayParts(option);
  const country = normalizeAdminText(countryName === "Unknown country" ? "" : countryName);
  const league = normalizeAdminText(leagueName || option.source_league_name);

  return [
    option.bookmaker_slug ?? "",
    country,
    league,
  ].join("::");
}

function mappedLeagueSourceKey(mapping) {
  return JSON.stringify({
    bookmakerSlug: mapping.bookmaker_slug ?? "",
    sourceCountryName: mapping.source_country_name ?? "",
    sourceLeagueName: mapping.source_league_name ?? "",
  });
}

function prepareLeagueOptions(options, mappings) {
  const mappedExactKeys = new Set(mappings.map(mappedLeagueSourceKey));
  const mappedLogicalKeys = new Set(mappings.map(leagueLogicalKey));
  const seenLogicalKeys = new Set();
  const prepared = [];

  for (const option of options) {
    if (mappedExactKeys.has(leagueSourceKey(option))) {
      continue;
    }

    const logicalKey = leagueLogicalKey(option);
    if (mappedLogicalKeys.has(logicalKey)) {
      continue;
    }

    if (seenLogicalKeys.has(logicalKey)) {
      continue;
    }

    seenLogicalKeys.add(logicalKey);
    prepared.push(option);
  }

  return prepared.sort((left, right) =>
    leagueDisplayLabel(left).localeCompare(leagueDisplayLabel(right)),
  );
}

function teamSourceKey(option) {
  return JSON.stringify({
    bookmakerSlug: option.bookmaker_slug ?? "",
    sourceTeamName: option.source_team_name ?? "",
  });
}

function canonicalLeagueLabel(option) {
  return option.canonical_country_name
    ? `${option.canonical_country_name} | ${option.canonical_league_name}`
    : option.canonical_league_name;
}

function canonicalTeamLabel(option) {
  return option.canonical_country_name
    ? `${option.canonical_country_name} | ${option.canonical_team_name}`
    : option.canonical_team_name;
}

async function postJson(url, payload = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.detail ?? `Request failed for ${url}`);
  }

  return response.json();
}

async function getJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.detail ?? `Request failed for ${url}`);
  }

  return response.json();
}

function renderEmpty(container, message) {
  const empty = document.createElement("p");
  empty.className = "empty-state";
  empty.textContent = message;
  container.replaceChildren(empty);
}

function setActiveTab(tabName) {
  for (const tab of elements.tabs) {
    tab.classList.toggle("admin-tab--active", tab.dataset.tab === tabName);
  }

  for (const panel of elements.panels) {
    panel.classList.toggle("admin-panel--active", panel.dataset.panel === tabName);
  }
}

function renderLeagueSuggestion(node, suggestion) {
  if (!suggestion) {
    node.hidden = true;
    return;
  }

  node.hidden = false;
  node.innerHTML = `
    <span class="admin-suggestion__label">Suggested mapping</span>
    <strong class="admin-suggestion__value">${suggestion.canonicalCountryName || "Unknown country"} | ${suggestion.canonicalLeagueName}</strong>
    <span class="admin-suggestion__confidence">Confidence ${pct(suggestion.confidence)}</span>
  `;
}

function renderEventSuggestion(node, suggestion) {
  const home = suggestion?.home ?? null;
  const away = suggestion?.away ?? null;

  if (!home && !away) {
    node.hidden = true;
    return;
  }

  node.hidden = false;

  const parts = [];

  if (home) {
    parts.push(`Home: ${home.canonicalTeamName} (${pct(home.confidence)})`);
  }

  if (away) {
    parts.push(`Away: ${away.canonicalTeamName} (${pct(away.confidence)})`);
  }

  node.innerHTML = `
    <span class="admin-suggestion__label">Suggested aliases</span>
    <strong class="admin-suggestion__value">${parts.join(" | ")}</strong>
  `;
}

function fillSelect(select, options, formatter) {
  select.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = options.length > 0 ? "Choose..." : "No options available";
  select.append(placeholder);

  for (const option of options) {
    const node = document.createElement("option");
    node.value = formatter.value(option);
    node.textContent = formatter.label(option);
    select.append(node);
  }

  select.disabled = options.length === 0;
  if (options.length > 0) {
    select.selectedIndex = 1;
  }
}

function renderMappingForms() {
  state.sourceLeagueOptions = Array.isArray(state.sourceLeagueOptions) ? state.sourceLeagueOptions : [];
  state.sourceTeamOptions = Array.isArray(state.sourceTeamOptions) ? state.sourceTeamOptions : [];
  state.canonicalTeamOptions = Array.isArray(state.canonicalTeamOptions) ? state.canonicalTeamOptions : [];
  state.mappedLeagues = Array.isArray(state.mappedLeagues) ? state.mappedLeagues : [];

  const merkurOptions = prepareLeagueOptions(
    state.sourceLeagueOptions.filter((o) => o.bookmaker_slug === "merkurxtip"),
    state.mappedLeagues.filter((m) => m.bookmaker_slug === "merkurxtip"),
  );
  const pinnacleOptions = prepareLeagueOptions(
    state.sourceLeagueOptions.filter((o) => o.bookmaker_slug === "pinnacle"),
    state.mappedLeagues.filter((m) => m.bookmaker_slug === "pinnacle"),
  );

  fillSelect(elements.leagueMappingForm.elements.merkurLeagueKey, merkurOptions, {
    value: leagueSourceKey,
    label: leagueDisplayLabel,
  });
  fillSelect(elements.leagueMappingForm.elements.pinnacleLeagueKey, pinnacleOptions, {
    value: leagueSourceKey,
    label: leagueDisplayLabel,
  });

  populateTeamLeagueFilter();
  applyTeamLeagueFilter();

  elements.leagueMappingForm.querySelector("button[type='submit']").disabled =
    merkurOptions.length === 0 || pinnacleOptions.length === 0;
}

function populateTeamLeagueFilter() {
  const seen = new Set();
  const filter = elements.teamLeagueFilter;
  const current = filter.value;
  filter.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All leagues";
  filter.append(all);

  for (const m of state.mappedLeagues) {
    const label = m.canonical_country_name
      ? `${m.canonical_country_name} — ${m.canonical_league_name}`
      : m.canonical_league_name;
    if (seen.has(label)) continue;
    seen.add(label);
    const opt = document.createElement("option");
    opt.value = m.canonical_league_name;
    opt.textContent = label;
    filter.append(opt);
  }

  if (current && [...filter.options].some((o) => o.value === current)) {
    filter.value = current;
  }
}

function applyTeamLeagueFilter() {
  const canonicalLeagueName = elements.teamLeagueFilter.value;
  const merkurAll = state.sourceTeamOptions.filter((o) => o.bookmaker_slug === "merkurxtip");
  const pinnacleAll = state.sourceTeamOptions.filter((o) => o.bookmaker_slug === "pinnacle");

  let merkurFiltered = merkurAll;
  let pinnacleFiltered = pinnacleAll;

  if (canonicalLeagueName) {
    const merkurMapping = state.mappedLeagues.find(
      (m) => m.canonical_league_name === canonicalLeagueName && m.bookmaker_slug === "merkurxtip",
    );
    const pinnacleMapping = state.mappedLeagues.find(
      (m) => m.canonical_league_name === canonicalLeagueName && m.bookmaker_slug === "pinnacle",
    );
    if (merkurMapping) {
      merkurFiltered = merkurAll.filter((t) => t.source_league_name === merkurMapping.source_league_name);
    }
    if (pinnacleMapping) {
      pinnacleFiltered = pinnacleAll.filter((t) => t.source_league_name === pinnacleMapping.source_league_name);
    }
    const anyMapping = merkurMapping || pinnacleMapping;
    if (anyMapping) {
      elements.teamMappingForm.elements.canonicalCountryName.value = anyMapping.canonical_country_name ?? "";
    }
  }

  fillSelect(elements.teamMappingForm.elements.merkurTeamKey, merkurFiltered, {
    value: teamSourceKey,
    label: (o) => o.source_team_name,
  });
  fillSelect(elements.teamMappingForm.elements.pinnacleTeamKey, pinnacleFiltered, {
    value: teamSourceKey,
    label: (o) => o.source_team_name,
  });

  elements.teamMappingForm.querySelector("button[type='submit']").disabled =
    merkurFiltered.length === 0 || pinnacleFiltered.length === 0;
}

function renderLeagues(leagues) {
  elements.leagues.replaceChildren();

  if (!Array.isArray(leagues) || leagues.length === 0) {
    renderEmpty(elements.leagues, "No open unmatched leagues.");
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const league of leagues) {
    const card = elements.leagueTemplate.content.firstElementChild.cloneNode(true);
    card.querySelector(".admin-card__eyebrow").textContent = `${league.bookmaker_slug} | ${league.seen_count}x`;
    card.querySelector(".admin-card__title").textContent = league.source_league_name;
    card.querySelector(".admin-card__meta").textContent =
      `${league.source_country_name ?? "Unknown country"} | last seen ${new Date(league.last_seen_at).toLocaleString()}`;
    renderLeagueSuggestion(card.querySelector(".admin-league-suggestion"), league.suggestion);

    const form = card.querySelector(".admin-form--league");
    form.elements.canonicalCountryName.value =
      league.suggestion?.canonicalCountryName ?? "";
    form.elements.canonicalLeagueName.value =
      league.suggestion?.canonicalLeagueName ?? league.source_league_name ?? "";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await postJson(`/api/admin/unmatched-leagues/${league.id}/map`, {
        canonicalCountryName: form.elements.canonicalCountryName.value.trim(),
        canonicalLeagueName: form.elements.canonicalLeagueName.value.trim(),
      });
      await loadAdminData();
    });

    const crossMatch = league.crossMatch;
    if (crossMatch) {
      const crossEl = card.querySelector(".admin-cross-match");
      crossEl.hidden = false;
      const bookmakerLabel = crossMatch.bookmakerSlug === "pinnacle" ? "Pinnacle" : crossMatch.bookmakerSlug === "merkurxtip" ? "Merkur" : crossMatch.bookmakerSlug;
      const sourceName = crossMatch.sourceCountryName
        ? `${crossMatch.sourceCountryName} | ${crossMatch.sourceLeagueName}`
        : crossMatch.sourceLeagueName;
      crossEl.innerHTML = `
        <span class="cross-match__label">${bookmakerLabel} match</span>
        <strong class="cross-match__value">${sourceName}</strong>
        <span class="cross-match__confidence">${Math.round(crossMatch.confidence * 100)}%</span>
      `;
      const useBtn = document.createElement("button");
      useBtn.type = "button";
      useBtn.className = "admin-button admin-button--ghost cross-match__btn";
      useBtn.textContent = "Use name";
      useBtn.addEventListener("click", () => {
        form.elements.canonicalLeagueName.value = crossMatch.sourceLeagueName;
      });
      const pairBtn = document.createElement("button");
      pairBtn.type = "button";
      pairBtn.className = "admin-button cross-match__btn";
      pairBtn.textContent = "Map pair";
      pairBtn.addEventListener("click", async () => {
        const canonicalCountryName = form.elements.canonicalCountryName.value.trim() || crossMatch.sourceCountryName || null;
        const canonicalLeagueName = form.elements.canonicalLeagueName.value.trim() || crossMatch.sourceLeagueName;
        await postJson(`/api/admin/unmatched-leagues/${league.id}/map`, { canonicalCountryName, canonicalLeagueName });
        await postJson("/api/admin/league-mappings", {
          bookmakerSlug: crossMatch.bookmakerSlug,
          sourceCountryName: crossMatch.sourceCountryName || null,
          sourceLeagueName: crossMatch.sourceLeagueName,
          canonicalCountryName,
          canonicalLeagueName,
        });
        await loadAdminData();
      });
      crossEl.append(useBtn, pairBtn);
    }

    card.querySelector(".admin-ignore-league").addEventListener("click", async () => {
      await postJson(`/api/admin/unmatched-leagues/${league.id}/ignore`);
      await loadAdminData();
    });

    fragment.append(card);
  }

  elements.leagues.append(fragment);
}

function renderEvents(events) {
  elements.events.replaceChildren();

  if (!Array.isArray(events) || events.length === 0) {
    renderEmpty(elements.events, "No open unmatched events.");
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const unmatchedEvent of events) {
    const card = elements.eventTemplate.content.firstElementChild.cloneNode(true);
    card.querySelector(".admin-card__eyebrow").textContent =
      `${unmatchedEvent.bookmaker_slug} | ${unmatchedEvent.seen_count}x`;
    card.querySelector(".admin-card__title").textContent =
      `${unmatchedEvent.source_home_name} vs ${unmatchedEvent.source_away_name}`;
    card.querySelector(".admin-card__meta").textContent =
      `${unmatchedEvent.source_country_name ?? "Unknown country"} | ${unmatchedEvent.source_league_name ?? "Unknown league"} | ${unmatchedEvent.source_start_time ? new Date(unmatchedEvent.source_start_time).toLocaleString() : "No kickoff"}`;
    renderEventSuggestion(card.querySelector(".admin-event-suggestion"), unmatchedEvent.suggestion);

    const form = card.querySelector(".admin-form--event");
    form.elements.canonicalCountryName.value =
      unmatchedEvent.suggestion?.home?.canonicalCountryName ??
      unmatchedEvent.suggestion?.away?.canonicalCountryName ??
      "";
    form.elements.canonicalHomeName.value =
      unmatchedEvent.suggestion?.home?.canonicalTeamName ?? unmatchedEvent.source_home_name ?? "";
    form.elements.canonicalAwayName.value =
      unmatchedEvent.suggestion?.away?.canonicalTeamName ?? unmatchedEvent.source_away_name ?? "";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await postJson(`/api/admin/unmatched-events/${unmatchedEvent.id}/map`, {
        canonicalCountryName: form.elements.canonicalCountryName.value.trim(),
        canonicalHomeName: form.elements.canonicalHomeName.value.trim(),
        canonicalAwayName: form.elements.canonicalAwayName.value.trim(),
      });
      await loadAdminData();
    });

    card.querySelector(".admin-ignore-event").addEventListener("click", async () => {
      await postJson(`/api/admin/unmatched-events/${unmatchedEvent.id}/ignore`);
      await loadAdminData();
    });

    fragment.append(card);
  }

  elements.events.append(fragment);
}

function renderMappedLeagues(mappings) {
  elements.mappedLeagues.replaceChildren();

  if (!Array.isArray(mappings) || mappings.length === 0) {
    renderEmpty(elements.mappedLeagues, "No active league mappings.");
    return;
  }

  const grouped = new Map();
  for (const mapping of mappings) {
    const key = `${mapping.canonical_country_name ?? ""}|${mapping.canonical_league_name}`;
    if (!grouped.has(key)) {
      grouped.set(key, { canonical_country_name: mapping.canonical_country_name, canonical_league_name: mapping.canonical_league_name, entries: [] });
    }
    grouped.get(key).entries.push(mapping);
  }

  const fragment = document.createDocumentFragment();

  for (const group of grouped.values()) {
    const row = elements.mappedLeagueTemplate.content.firstElementChild.cloneNode(true);

    const canonicalLabel = group.canonical_country_name
      ? `${group.canonical_country_name} — ${group.canonical_league_name}`
      : group.canonical_league_name;
    row.querySelector(".mapped-row__canonical").textContent = canonicalLabel;

    const sourcesEl = row.querySelector(".mapped-row__sources");
    const actionsEl = row.querySelector(".mapped-row__actions");

    for (const entry of group.entries) {
      const chip = document.createElement("span");
      chip.className = "mapped-source-chip";
      chip.textContent = `${entry.bookmaker_name}: ${entry.source_country_name ? entry.source_country_name + " | " : ""}${entry.source_league_name}`;
      sourcesEl.append(chip);

      const btn = document.createElement("button");
      btn.className = "admin-button admin-button--ghost mapped-unmap-btn";
      btn.textContent = `Unmap ${entry.bookmaker_name}`;
      btn.addEventListener("click", async () => {
        await postJson(`/api/admin/league-mappings/${entry.id}/unmap`);
        await loadAdminData();
      });
      actionsEl.append(btn);
    }

    fragment.append(row);
  }

  elements.mappedLeagues.append(fragment);
}

function renderMappedTeams(mappings) {
  elements.mappedTeams.replaceChildren();

  if (!Array.isArray(mappings) || mappings.length === 0) {
    renderEmpty(elements.mappedTeams, "No active team mappings.");
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const mapping of mappings) {
    const card = elements.mappedTeamTemplate.content.firstElementChild.cloneNode(true);
    card.querySelector(".admin-card__eyebrow").textContent = mapping.bookmaker_name;
    card.querySelector(".admin-card__title").textContent = mapping.source_team_name;
    card.querySelector(".admin-card__meta").textContent =
      `${mapping.canonical_country_name ?? "Unknown country"} | ${mapping.canonical_team_name}`;
    card.querySelector(".admin-unmap-team").addEventListener("click", async () => {
      await postJson(`/api/admin/team-mappings/${mapping.id}/unmap`);
      await loadAdminData();
    });
    fragment.append(card);
  }

  elements.mappedTeams.append(fragment);
}

function applyCoverage(status, review) {
  const coverage = review.coverage ?? {};

  elements.dbStatus.textContent =
    status.config?.hasUrl && status.config?.hasAuthToken ? "Configured" : "Missing env";
  elements.leagueCount.textContent = Array.isArray(review.unmatchedLeagues)
    ? review.unmatchedLeagues.length
    : 0;
  elements.eventCount.textContent = Array.isArray(review.unmatchedEvents)
    ? review.unmatchedEvents.length
    : 0;
  elements.merkurLeagues.textContent = coverage.merkur?.totalLeagues ?? 0;
  elements.merkurMatches.textContent = coverage.merkur?.totalMatches ?? 0;
  elements.pinnacleLeagues.textContent = coverage.pinnacle?.totalLeagues ?? 0;
  elements.pinnacleMatches.textContent = coverage.pinnacle?.totalMatches ?? 0;
  elements.comparableLeagues.textContent = coverage.comparable?.matchedLeagues ?? 0;
  elements.comparableMatches.textContent = coverage.comparable?.matchedMatches ?? 0;
}

async function loadAdminData() {
  elements.message.textContent = "Loading admin review queue...";

  const [status, review, mappings] = await Promise.all([
    getJson("/api/admin/status"),
    getJson("/api/admin/review"),
    getJson("/api/admin/mappings"),
  ]);

  applyCoverage(status, review);
  elements.message.textContent = "Review, map, and unmap bookmaker-specific rows below.";

  state.sourceLeagueOptions = mappings.sourceLeagueOptions ?? [];
  state.sourceTeamOptions = mappings.sourceTeamOptions ?? [];
  state.canonicalLeagueOptions = mappings.canonicalLeagueOptions ?? [];
  state.canonicalTeamOptions = mappings.canonicalTeamOptions ?? [];
  state.mappedLeagues = mappings.mappedLeagues ?? [];

  console.log("[admin] sourceTeamOptions:", state.sourceTeamOptions.length,
    "merkur:", state.sourceTeamOptions.filter(o => o.bookmaker_slug === "merkurxtip").length,
    "pinnacle:", state.sourceTeamOptions.filter(o => o.bookmaker_slug === "pinnacle").length,
    "sample:", state.sourceTeamOptions[0]);

  renderLeagues(review.unmatchedLeagues);
  renderEvents(review.unmatchedEvents);
  renderMappingForms();
  renderMappedLeagues(mappings.mappedLeagues);
  renderMappedTeams(mappings.mappedTeams);
}

elements.leagueMappingForm.querySelectorAll("[data-use-name]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.dataset.useName === "merkur"
      ? elements.leagueMappingForm.elements.merkurLeagueKey.value
      : elements.leagueMappingForm.elements.pinnacleLeagueKey.value;
    if (!key) return;
    const parsed = JSON.parse(key);
    elements.leagueMappingForm.elements.canonicalLeagueName.value = parsed.sourceLeagueName ?? "";
    autoFillCanonicalCountry({
      fallbackCountryName: parsed.sourceCountryName ?? "",
    });
  });
});

elements.leagueMappingForm.elements.canonicalLeagueName.addEventListener("input", () => {
  autoFillCanonicalCountry();
});

elements.leagueMappingForm.elements.canonicalCountryName.addEventListener("input", (event) => {
  const autoValue = event.currentTarget.dataset.autoValue ?? "";

  if (event.currentTarget.value.trim() !== autoValue) {
    delete event.currentTarget.dataset.autoValue;
  }
});

elements.leagueMappingForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const merkur = JSON.parse(elements.leagueMappingForm.elements.merkurLeagueKey.value);
  const pinnacle = JSON.parse(elements.leagueMappingForm.elements.pinnacleLeagueKey.value);
  const canonicalCountryName = elements.leagueMappingForm.elements.canonicalCountryName.value.trim() || null;
  const canonicalLeagueName = elements.leagueMappingForm.elements.canonicalLeagueName.value.trim();

  await postJson("/api/admin/league-mappings", {
    bookmakerSlug: merkur.bookmakerSlug,
    sourceCountryName: merkur.sourceCountryName || null,
    sourceLeagueName: merkur.sourceLeagueName,
    canonicalCountryName,
    canonicalLeagueName,
  });
  await postJson("/api/admin/league-mappings", {
    bookmakerSlug: pinnacle.bookmakerSlug,
    sourceCountryName: pinnacle.sourceCountryName || null,
    sourceLeagueName: pinnacle.sourceLeagueName,
    canonicalCountryName,
    canonicalLeagueName,
  });

  await loadAdminData();
  setActiveTab("mapped-leagues");
});

elements.teamLeagueFilter.addEventListener("change", applyTeamLeagueFilter);

elements.teamMappingForm.querySelectorAll("[data-use-team-name]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.dataset.useTeamName === "merkur"
      ? elements.teamMappingForm.elements.merkurTeamKey.value
      : elements.teamMappingForm.elements.pinnacleTeamKey.value;
    if (!key) return;
    const parsed = JSON.parse(key);
    elements.teamMappingForm.elements.canonicalTeamName.value = parsed.sourceTeamName ?? "";
  });
});

elements.teamMappingForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const merkur = JSON.parse(elements.teamMappingForm.elements.merkurTeamKey.value);
  const pinnacle = JSON.parse(elements.teamMappingForm.elements.pinnacleTeamKey.value);
  const canonicalCountryName = elements.teamMappingForm.elements.canonicalCountryName.value.trim() || null;
  const canonicalTeamName = elements.teamMappingForm.elements.canonicalTeamName.value.trim();

  await postJson("/api/admin/team-mappings", {
    bookmakerSlug: merkur.bookmakerSlug,
    sourceTeamName: merkur.sourceTeamName,
    canonicalCountryName,
    canonicalTeamName,
  });
  await postJson("/api/admin/team-mappings", {
    bookmakerSlug: pinnacle.bookmakerSlug,
    sourceTeamName: pinnacle.sourceTeamName,
    canonicalCountryName,
    canonicalTeamName,
  });

  await loadAdminData();
  setActiveTab("mapped-teams");
});

for (const tab of elements.tabs) {
  tab.addEventListener("click", () => {
    setActiveTab(tab.dataset.tab);
  });
}

elements.refreshButton.addEventListener("click", () => {
  loadAdminData().catch((error) => {
    elements.message.textContent = error.message;
  });
});

setActiveTab("review");
loadAdminData().catch((error) => {
  elements.message.textContent = error.message;
});
