// Humanizes raw artifact/fetch error text for user-facing surfaces (run-list
// card, sounding drawer). The messages the fetch layer produces are built for
// diagnostics — multi-origin failover dumps full of URLs, DOMException names,
// HTTP status lines — and are unreadable in the UI. This pure helper collapses
// them into one short, URL-free sentence. It must stay side-effect free and
// must never emit a raw URL.

const FALLBACK_MESSAGE = "Something went wrong while loading data.";
const MAX_MESSAGE_LENGTH = 160;
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s|,;]+|(?:^|\s)\/__cf[^\s|,;]*/gi;

export function humanizeArtifactError(raw: unknown): string {
  const { name, message } = extractErrorText(raw);
  const combined = `${name}: ${message}`;
  if (/abort/i.test(name) || /\baborted\b|\bcancell?ed\b/i.test(message)) {
    return "The request was cancelled before it finished.";
  }
  if (/\btimed?[\s-]?out\b|\btimeout\b/i.test(combined)) {
    return "The request timed out — the data source may be slow or unreachable.";
  }
  if (/unable to load runs\b/i.test(message)) {
    return "Couldn't load the model run list from any data source.";
  }
  if (/unable to load manifest\b/i.test(message)) {
    return "Couldn't load the frame manifest from any data source.";
  }
  if (/\bno runs\b/i.test(message)) {
    return "No model runs are available yet.";
  }
  if (/\b404\b|\bnot found\b/i.test(combined)) {
    return "The requested data isn't available yet (404) — it may not be built.";
  }
  if (
    /failed to fetch|networkerror|network request failed|load failed|fetch failed|connection refused|err_network|err_internet|err_connection/i.test(
      combined,
    )
  ) {
    return "Couldn't reach the data source — is the local data server running?";
  }
  return collapseToSingleSentence(message) || FALLBACK_MESSAGE;
}

function extractErrorText(raw: unknown): { name: string; message: string } {
  if (raw instanceof Error) {
    return { name: String(raw.name || ""), message: String(raw.message || "") };
  }
  if (typeof raw === "string") {
    return { name: "", message: raw };
  }
  if (raw && typeof raw === "object") {
    const candidate = raw as { name?: unknown; message?: unknown };
    return {
      name: typeof candidate.name === "string" ? candidate.name : "",
      message: typeof candidate.message === "string" ? candidate.message : "",
    };
  }
  return { name: "", message: raw === null || raw === undefined ? "" : String(raw) };
}

// Fallback path for unrecognized input: strip bare URLs, take the first
// non-empty line, dedupe the repeated per-origin segments failover dumps
// produce ("origin: reason | origin: reason"), and truncate what remains.
function collapseToSingleSentence(message: string): string {
  const withoutUrls = String(message || "").replace(URL_PATTERN, " ");
  const firstLine =
    withoutUrls
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) || "";
  const segments = firstLine
    .split(/\||\btried:\s*/i)
    .map((segment) =>
      segment
        .replace(/\s+/g, " ")
        .replace(/^[\s:;,.–—-]+/g, "")
        .replace(/[\s:;,–—-]+$/g, "")
        .trim(),
    )
    .filter((segment) => segment.length > 0);
  const seen = new Set<string>();
  const deduped = segments.filter((segment) => {
    const key = segment.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  const sentence = deduped.join("; ");
  if (sentence.length <= MAX_MESSAGE_LENGTH) {
    return sentence;
  }
  return `${sentence.slice(0, MAX_MESSAGE_LENGTH - 1).trimEnd()}…`;
}
