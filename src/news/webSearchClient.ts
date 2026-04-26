import { env } from "../config/env";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
  source: string;
}

interface TavilySearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    published_date?: string;
  }>;
}

export class WebSearchClient {
  async search(params: { query: string; maxResults?: number | null }): Promise<WebSearchResult[]> {
    const query = params.query.trim();
    if (!query) {
      return [];
    }
    if (!env.WEB_SEARCH_API_KEY.trim()) {
      throw new Error("WEB_SEARCH_API_KEY is missing.");
    }

    const maxResults = normalizeMaxResults(params.maxResults);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, env.WEB_SEARCH_TIMEOUT_MS);

    try {
      const response = await fetch(env.WEB_SEARCH_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        signal: controller.signal,
        body: JSON.stringify({
          api_key: env.WEB_SEARCH_API_KEY,
          query,
          max_results: maxResults,
          search_depth: "basic",
          include_answer: false,
          include_raw_content: false
        })
      });

      if (!response.ok) {
        throw new Error(`Web search request failed with status ${response.status}.`);
      }

      const payload = (await response.json()) as TavilySearchResponse;
      const rawResults = payload.results ?? [];

      return rawResults
        .map((item) => ({
          title: item.title?.trim() ?? "",
          url: item.url?.trim() ?? "",
          snippet: normalizeSnippet(item.content ?? ""),
          publishedAt: normalizePublishedAt(item.published_date),
          source: extractSource(item.url ?? "")
        }))
        .filter((item) => item.title && item.url)
        .slice(0, maxResults);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function normalizeMaxResults(raw: number | null | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return env.WEB_SEARCH_MAX_RESULTS;
  }
  return Math.max(1, Math.min(10, Math.trunc(raw)));
}

function normalizeSnippet(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= 500) {
    return normalized;
  }
  return `${normalized.slice(0, 499)}…`;
}

function normalizePublishedAt(value?: string): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function extractSource(url: string): string {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const withoutWww = hostname.replace(/^www\./, "");
    return withoutWww || "web";
  } catch {
    return "web";
  }
}
