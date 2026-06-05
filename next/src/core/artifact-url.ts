const DEFAULT_ARTIFACT_BASE = "http://127.0.0.1:5174";

let resolvedBaseUrl = "";

export function getArtifactBaseUrl(): string {
  if (resolvedBaseUrl) {
    return resolvedBaseUrl;
  }
  return getCandidateArtifactBaseUrls()[0];
}

export function setResolvedArtifactBaseUrl(baseUrl: string): void {
  resolvedBaseUrl = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "");
}

export function resetResolvedArtifactBaseUrl(): void {
  resolvedBaseUrl = "";
}

export function buildArtifactUrl(key: string): string {
  const cleanKey = String(key || "").replace(/^\/+/, "");
  return `${getArtifactBaseUrl()}/${cleanKey}`;
}

export function getCandidateArtifactBaseUrls(): string[] {
  const direct = String(import.meta.env.VITE_ARTIFACT_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  const devProxy = import.meta.env.DEV ? "/__cf" : "";
  const list = import.meta.env.DEV ? [devProxy, direct, DEFAULT_ARTIFACT_BASE] : [direct, DEFAULT_ARTIFACT_BASE];
  return list.filter((value, index) => list.indexOf(value) === index);
}

export function appendQueryParams(url: string, values: Record<string, string>): string {
  const [base, existing = ""] = String(url || "").split("?");
  const params = new URLSearchParams(existing);
  for (const [key, value] of Object.entries(values)) {
    params.set(key, value);
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
