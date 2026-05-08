const DEFAULT_HEADERS = {
  accept: "application/json, text/plain, */*",
  "user-agent": "Mozilla/5.0 BetTool/0.1",
};

export class HttpError extends Error {
  constructor(message, { status, statusText, url, retryAfterMs } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status ?? null;
    this.statusText = statusText ?? "";
    this.url = url ?? "";
    this.retryAfterMs = retryAfterMs ?? null;
  }
}

function sleep(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function fetchJson(url, extraOptions = {}) {
  const retries = extraOptions.retries ?? 0;
  const retryDelayMs = extraOptions.retryDelayMs ?? 750;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        ...DEFAULT_HEADERS,
        ...(extraOptions.headers ?? {}),
      },
      ...extraOptions,
    });

    if (response.ok) {
      return response.json();
    }

    if (response.status === 429 && attempt < retries) {
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const delayMs = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1000
        : retryDelayMs * (attempt + 1);
      await sleep(delayMs);
      continue;
    }

    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(retryAfterSeconds)
      ? retryAfterSeconds * 1000
      : null;

    throw new HttpError(
      `Request failed: ${response.status} ${response.statusText} for ${url}`,
      {
        status: response.status,
        statusText: response.statusText,
        url,
        retryAfterMs,
      },
    );
  }
}
