import { DateTime } from "luxon";

import { env } from "../config/env";
import { OpenAiClient } from "../ai/openaiClient";
import { WebSearchClient, type WebSearchResult } from "./webSearchClient";

export class NewsService {
  constructor(
    private readonly openAiClient: OpenAiClient,
    private readonly webSearchClient: WebSearchClient
  ) {}

  async buildDigest(params: { topic?: string | null; maxItems?: number | null }): Promise<string> {
    const topic = normalizeTopicQuery(params.topic);
    const maxItems = normalizeMaxItems(params.maxItems);

    let selected: WebSearchResult[] = [];
    try {
      selected = await this.webSearchClient.search({
        query: topic,
        maxResults: maxItems
      });
    } catch (error) {
      console.warn("web_search_failed", error);
      return [
        `I couldn't search the web for "${topic}" right now.`,
        "Please try again in a few minutes."
      ].join("\n");
    }

    if (selected.length < 1) {
      return [
        `I couldn't find fresh web results for "${topic}" right now.`,
        "Try again in a few minutes or rephrase the topic."
      ].join("\n");
    }

    const summary = await this.openAiClient.summarizeNewsSearchResults({
      topic,
      results: selected
    });

    return [
      `📰 ${topic} news digest`,
      `Updated ${DateTime.now().setZone(env.APP_TIMEZONE).toFormat("dd/LL/yyyy HH:mm")}`,
      "",
      summary,
      "",
      "Sources:",
      ...selected.map((item, index) => {
        const timestamp = formatPublishedTime(item.publishedAt);
        const title = truncate(item.title, 180);
        return `${index + 1}. ${title}${timestamp ? ` (${timestamp})` : ""}\n   ${item.url}`;
      })
    ].join("\n");
  }

  getSupportedCategoriesText(): string {
    return "Any topic, for example: OpenAI, Nvidia earnings, global inflation, TypeScript 6.";
  }
}

function parsePublishedAtMs(publishedAt: string | null): number {
  if (!publishedAt) {
    return 0;
  }
  const parsed = DateTime.fromRFC2822(publishedAt);
  if (parsed.isValid) {
    return parsed.toMillis();
  }
  const parsedIso = DateTime.fromISO(publishedAt);
  if (parsedIso.isValid) {
    return parsedIso.toMillis();
  }
  const nativeMs = Date.parse(publishedAt);
  return Number.isFinite(nativeMs) ? nativeMs : 0;
}

function formatPublishedTime(publishedAt: string | null): string | null {
  const ms = parsePublishedAtMs(publishedAt);
  if (ms <= 0) {
    return null;
  }
  return DateTime.fromMillis(ms).setZone(env.APP_TIMEZONE).toFormat("dd/LL HH:mm");
}

function normalizeMaxItems(rawMaxItems: number | null | undefined): number {
  if (typeof rawMaxItems !== "number" || !Number.isFinite(rawMaxItems)) {
    return env.NEWS_MAX_ITEMS;
  }
  return Math.max(1, Math.min(10, Math.trunc(rawMaxItems)));
}

function normalizeTopicQuery(rawTopic: string | null | undefined): string {
  const normalized = (rawTopic ?? "").trim();
  return normalized || "latest world news";
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}
