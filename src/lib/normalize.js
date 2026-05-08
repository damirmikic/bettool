const STOP_WORDS = new Set([
  "fc",
  "fk",
  "cf",
  "sc",
  "ac",
  "club",
  "football",
  "fudbal",
  "team",
]);

export function normalizeTeamName(name) {
  return String(name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((part) => !STOP_WORDS.has(part))
    .join(" ");
}

export function normalizeEventKey(key) {
  return `${normalizeTeamName(key.home)}::${normalizeTeamName(key.away)}`;
}

export function cleanDisplayText(value) {
  if (value == null) {
    return null;
  }

  const normalized = String(value).replace(/\s+/g, " ").trim();
  return normalized || null;
}

export function createEventKey(home, away) {
  return {
    home: cleanDisplayText(home),
    away: cleanDisplayText(away),
  };
}
