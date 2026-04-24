import { DateTime } from "luxon";

import { env } from "../config/env";
import {
  getSupportedNewsCategories,
  resolveNewsFeeds,
  type NewsCategory,
  type RssFeedSource
} from "./feeds";

interface FeedItem {
  title: string;
  link: string;
  publishedAt: string | null;
  sourceName: string;
}

export class NewsService {
  async buildDigest(params: { category?: string | null; maxItems?: number | null }): Promise<string> {
    const { category, feeds } = resolveNewsFeeds(params.category);
    const maxItems = normalizeMaxItems(params.maxItems);

    const feedResults = await Promise.all(
      feeds.map(async (feed) => {
        try {
          return await this.fetchFeedItems(feed);
        } catch (error) {
          console.warn(`news_feed_fetch_failed (${feed.name})`, error);
          return [];
        }
      })
    );

    const deduped = dedupeFeedItems(feedResults.flat());
    const sortedByDate = deduped.sort((a, b) => {
      const aMs = parsePublishedAtMs(a.publishedAt);
      const bMs = parsePublishedAtMs(b.publishedAt);
      return bMs - aMs;
    });
    const selected = sortedByDate.slice(0, maxItems);

    if (selected.length < 1) {
      const categoryLabel = toCategoryLabel(category);
      const supported = getSupportedNewsCategories().join(", ");
      return [
        `I couldn't fetch fresh ${categoryLabel} news right now.`,
        `Try again in a few minutes, or choose another category: ${supported}.`
      ].join("\n");
    }

    const lines = selected.map((item, index) => {
      const timestamp = formatPublishedTime(item.publishedAt);
      const title = truncate(item.title, 180);
      return `${index + 1}. ${title}\n   Source: ${item.sourceName}${timestamp ? ` (${timestamp})` : ""}\n   ${item.link}`;
    });

    return [
      `📰 ${toCategoryLabel(category)} news digest`,
      `Updated ${DateTime.now().setZone(env.APP_TIMEZONE).toFormat("dd/LL/yyyy HH:mm")}`,
      "",
      ...lines
    ].join("\n");
  }

  getSupportedCategoriesText(): string {
    return getSupportedNewsCategories().join(", ");
  }

  private async fetchFeedItems(feed: RssFeedSource): Promise<FeedItem[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, env.NEWS_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(feed.url, {
        headers: {
          "User-Agent": "telgram-agent-news-fetcher/1.0",
          Accept: "application/rss+xml, application/xml, text/xml, application/atom+xml"
        },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const xml = await response.text();
      return parseRssOrAtom(xml, feed.name);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function parseRssOrAtom(xml: string, sourceName: string): FeedItem[] {
  const rssItems = extractRssItems(xml, sourceName);
  if (rssItems.length > 0) {
    return rssItems;
  }
  return extractAtomEntries(xml, sourceName);
}

function extractRssItems(xml: string, sourceName: string): FeedItem[] {
  const blocks = matchBlocks(xml, "item");
  return blocks
    .map((block) => ({
      title: decodeXml(extractTagValue(block, "title")),
      link: decodeXml(extractTagValue(block, "link")),
      publishedAt: decodeXml(extractTagValue(block, "pubDate")) || null,
      sourceName
    }))
    .filter((item) => item.title && item.link);
}

function extractAtomEntries(xml: string, sourceName: string): FeedItem[] {
  const blocks = matchBlocks(xml, "entry");
  return blocks
    .map((block) => ({
      title: decodeXml(extractTagValue(block, "title")),
      link: decodeXml(extractAtomLink(block)),
      publishedAt: decodeXml(extractTagValue(block, "updated") || extractTagValue(block, "published")) || null,
      sourceName
    }))
    .filter((item) => item.title && item.link);
}

function extractTagValue(xmlChunk: string, tagName: string): string {
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = xmlChunk.match(pattern);
  if (!match) {
    return "";
  }
  return stripCdata(match[1]).trim();
}

function extractAtomLink(xmlChunk: string): string {
  const selfClosingMatch = xmlChunk.match(/<link\b([^>]*)\/>/i);
  if (selfClosingMatch) {
    const href = extractAttributeValue(selfClosingMatch[1], "href");
    if (href) {
      return href;
    }
  }

  const fullTagMatch = xmlChunk.match(/<link\b([^>]*)>([\s\S]*?)<\/link>/i);
  if (fullTagMatch) {
    const href = extractAttributeValue(fullTagMatch[1], "href");
    if (href) {
      return href;
    }
    return fullTagMatch[2].trim();
  }

  return "";
}

function extractAttributeValue(attributesChunk: string, attributeName: string): string {
  const pattern = new RegExp(`${attributeName}\\s*=\\s*['"]([^'"]+)['"]`, "i");
  const match = attributesChunk.match(pattern);
  return match?.[1]?.trim() ?? "";
}

function matchBlocks(xml: string, tagName: string): string[] {
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  const blocks: string[] = [];
  let match = pattern.exec(xml);
  while (match) {
    blocks.push(match[1]);
    match = pattern.exec(xml);
  }
  return blocks;
}

function stripCdata(text: string): string {
  return text.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function decodeXml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function dedupeFeedItems(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  const unique: FeedItem[] = [];
  for (const item of items) {
    const key = `${item.link.trim().toLowerCase()}|${item.title.trim().toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return unique;
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

function toCategoryLabel(category: NewsCategory): string {
  switch (category) {
    case "ai":
      return "AI";
    case "technology":
      return "Technology";
    case "business":
      return "Business";
    case "crypto":
      return "Crypto";
    case "world":
      return "World";
    default:
      return "General";
  }
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}
