import { DateTime } from "luxon";

import type { ParsedReminderIntent } from "../types/domain";
import { OpenAiClient } from "./openaiClient";

export class IntentParserService {
  constructor(private readonly openAiClient: OpenAiClient) {}

  async extractReminderIntent(
    userMessage: string,
    timezone: string
  ): Promise<ParsedReminderIntent> {
    const nowInTz = DateTime.now().setZone(timezone);
    const parsed = await this.openAiClient.parseReminderIntent({
      userMessage,
      timezone,
      nowIsoInTimezone: nowInTz.toISO() ?? nowInTz.toString()
    });

    if (!parsed.isReminder) {
      return parsed;
    }

    return normalizeReminderIntent(parsed, timezone, nowInTz);
  }

  async extractMultipleReminderIntents(
    userMessage: string,
    timezone: string
  ): Promise<ParsedReminderIntent[]> {
    const nowInTz = DateTime.now().setZone(timezone);
    const parsed = await this.openAiClient.parseMultipleReminderIntents({
      userMessage,
      timezone,
      nowIsoInTimezone: nowInTz.toISO() ?? nowInTz.toString()
    });

    return parsed
      .filter((intent) => intent.isReminder)
      .map((intent) => normalizeReminderIntent(intent, timezone, nowInTz));
  }

  async extractMultipleTaskItems(userMessage: string): Promise<string[]> {
    return this.openAiClient.parseMultipleTaskItems({ userMessage });
  }
}

function normalizeReminderIntent(
  intent: ParsedReminderIntent,
  timezone: string,
  nowInTz: DateTime
): ParsedReminderIntent {
  if (!intent.dueAtIso || !intent.reminderMessage) {
    return {
      ...intent,
      confidence: Math.min(intent.confidence, 0.5)
    };
  }

  const dueLocal = DateTime.fromISO(intent.dueAtIso, { zone: timezone });
  if (!dueLocal.isValid) {
    return {
      ...intent,
      dueAtIso: null,
      confidence: Math.min(intent.confidence, 0.4),
      reason: "Could not parse target reminder date."
    };
  }

  if (dueLocal <= nowInTz) {
    return {
      ...intent,
      dueAtIso: null,
      confidence: Math.min(intent.confidence, 0.4),
      reason: "Reminder time must be in the future."
    };
  }

  return {
    ...intent,
    dueAtIso: dueLocal.toISO()
  };
}
