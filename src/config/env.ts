import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "n", "off"].includes(normalized)) {
      return false;
    }
  }
  return value;
}, z.boolean());

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  AI_API_KEY: z.string().min(1, "AI_API_KEY is required"),
  OPENAI_MODEL: z.string().min(1).default("gpt-4o-mini"),
  ACTION_PLANNER_ENABLED: booleanFromEnv.default(true),
  ACTION_PLANNER_LEGACY_FALLBACK: booleanFromEnv.default(false),
  MEMORY_EXTRACTION_ENABLED: booleanFromEnv.default(false),
  DATABASE_PATH: z.string().min(1).default("./data/bot.sqlite"),
  APP_TIMEZONE: z.string().min(1).default("Asia/Jerusalem"),
  SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(20),
  NEWS_SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  NEWS_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  NEWS_MAX_ITEMS: z.coerce.number().int().min(1).max(10).default(5),
  WEB_SEARCH_API_URL: z.string().url().default("https://api.tavily.com/search"),
  WEB_SEARCH_API_KEY: z.string().default(""),
  WEB_SEARCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  WEB_SEARCH_MAX_RESULTS: z.coerce.number().int().min(1).max(10).default(5),
  MEMORY_MESSAGE_LIMIT: z.coerce.number().int().positive().default(6),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(15000)
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const errors = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment variables: ${errors}`);
}

export const env = parsed.data;
