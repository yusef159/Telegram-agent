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
    const maxResults = normalizeMaxResults(params.maxResults);
    const apiKey = env.WEB_SEARCH_API_KEY.trim();
    if (!apiKey) {
      return this.searchWithGoogleNewsRss(query, maxResults);
    }

    try {
      const primaryResults = await this.searchWithExternalApi(query, maxResults, apiKey);
      if (primaryResults.length > 0) {
        return primaryResults;
      }
    } catch (error) {
      console.warn("primary_web_search_failed", error);
    }

    return this.searchWithGoogleNewsRss(query, maxResults);
  }

  private async searchWithExternalApi(
    query: string,
    maxResults: number,
    apiKey: string
  ): Promise<WebSearchResult[]> {
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
          api_key: apiKey,
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

  private async searchWithGoogleNewsRss(
    query: string,
    maxResults: number
  ): Promise<WebSearchResult[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, env.NEWS_FETCH_TIMEOUT_MS);

    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "telgram-agent-news-fetcher/1.0",
          Accept: "application/rss+xml, application/xml, text/xml"
        }
      });
      if (!response.ok) {
        throw new Error(`Google News RSS failed with status ${response.status}.`);
      }
      const xml = await response.text();
      const items = parseGoogleNewsRss(xml);
      return items.slice(0, maxResults);
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

function parseGoogleNewsRss(xml: string): WebSearchResult[] {
  const itemPattern = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  const results: WebSearchResult[] = [];
  let match = itemPattern.exec(xml);
  while (match) {
    const block = match[1] ?? "";
    const title = decodeXml(stripCdata(extractTagValue(block, "title"))).trim();
    const url = decodeXml(stripCdata(extractTagValue(block, "link"))).trim();
    const publishedAt = decodeXml(stripCdata(extractTagValue(block, "pubDate"))).trim() || null;
    const description = decodeXml(stripCdata(extractTagValue(block, "description"))).trim();
    const snippet = normalizeSnippet(stripHtml(description));
    if (title && url) {
      results.push({
        title,
        url,
        snippet,
        publishedAt,
        source: extractSource(url)
      });
    }
    match = itemPattern.exec(xml);
  }
  return results;
}

function extractTagValue(xmlChunk: string, tagName: string): string {
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = xmlChunk.match(pattern);
  return match?.[1] ?? "";
}

function stripCdata(text: string): string {
  return text.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeXml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
