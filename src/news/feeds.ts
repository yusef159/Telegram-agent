export interface RssFeedSource {
  name: string;
  url: string;
}

export type NewsCategory = "ai" | "technology" | "business" | "crypto" | "world";

const CATEGORY_ALIASES: Record<NewsCategory, string[]> = {
  ai: ["ai", "artificial intelligence", "ml", "machine learning", "llm", "models", "chatgpt"],
  technology: ["tech", "technology", "software", "startup", "startups"],
  business: ["business", "economy", "finance", "markets"],
  crypto: ["crypto", "cryptocurrency", "bitcoin", "blockchain", "web3"],
  world: ["world", "global", "international", "politics"]
};

const CATEGORY_FEEDS: Record<NewsCategory, RssFeedSource[]> = {
  ai: [
    { name: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/" },
    { name: "MIT Technology Review AI", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed/" },
    { name: "OpenAI Blog", url: "https://openai.com/news/rss.xml" }
  ],
  technology: [
    { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
    { name: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
    { name: "Wired", url: "https://www.wired.com/feed/rss" }
  ],
  business: [
    { name: "Reuters Business", url: "https://feeds.reuters.com/reuters/businessNews" },
    { name: "CNBC Top News", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
    { name: "Financial Times", url: "https://www.ft.com/rss/home" }
  ],
  crypto: [
    { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
    { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
    { name: "The Block", url: "https://www.theblock.co/rss.xml" }
  ],
  world: [
    { name: "BBC World", url: "http://feeds.bbci.co.uk/news/world/rss.xml" },
    { name: "Reuters World", url: "https://feeds.reuters.com/Reuters/worldNews" },
    { name: "AP News", url: "https://apnews.com/hub/apf-topnews?output=rss" }
  ]
};

export function normalizeNewsCategory(rawCategory?: string | null): NewsCategory | null {
  const normalized = (rawCategory ?? "").toLowerCase().trim();
  if (!normalized) {
    return null;
  }

  for (const [category, aliases] of Object.entries(CATEGORY_ALIASES) as Array<[NewsCategory, string[]]>) {
    if (aliases.some((alias) => normalized.includes(alias))) {
      return category;
    }
  }

  return null;
}

export function resolveNewsFeeds(rawCategory?: string | null): {
  category: NewsCategory;
  feeds: RssFeedSource[];
} {
  const category = normalizeNewsCategory(rawCategory) ?? "ai";
  return {
    category,
    feeds: CATEGORY_FEEDS[category]
  };
}

export function getSupportedNewsCategories(): NewsCategory[] {
  return ["ai", "technology", "business", "crypto", "world"];
}
