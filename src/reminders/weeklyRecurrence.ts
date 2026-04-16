import { DateTime } from "luxon";
import { z } from "zod";

const weeklyRecurrenceStoredSchema = z.object({
  kind: z.literal("weekly"),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59)
});

export type WeeklyRecurrenceStored = z.infer<typeof weeklyRecurrenceStoredSchema>;

const WEEKDAY_SHORT = ["?", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function impliesWeeklyRecurrenceInUserText(text: string): boolean {
  return /\b(every|weekly|recur(?:ring|s)?)\b/i.test(text);
}

export function extractMentionedWeekdays(text: string): number[] {
  const regex =
    /\b(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?\b/gi;
  const found: number[] = [];
  const seen = new Set<number>();

  let match: RegExpExecArray | null = regex.exec(text);
  while (match) {
    const value = normalizeWeekdayToken(match[1]);
    if (value && !seen.has(value)) {
      seen.add(value);
      found.push(value);
    }
    match = regex.exec(text);
  }

  return found;
}

function normalizeWeekdayToken(token: string): number | null {
  const normalized = token.toLowerCase();
  if (normalized.startsWith("mon")) {
    return 1;
  }
  if (normalized.startsWith("tue")) {
    return 2;
  }
  if (normalized.startsWith("wed")) {
    return 3;
  }
  if (normalized.startsWith("thu")) {
    return 4;
  }
  if (normalized.startsWith("fri")) {
    return 5;
  }
  if (normalized.startsWith("sat")) {
    return 6;
  }
  if (normalized.startsWith("sun")) {
    return 7;
  }
  return null;
}

export function parseTimeOfDayFromText(
  text: string,
  nowInTz: DateTime
): { hour: number; minute: number } | null {
  const amPmMatch = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (amPmMatch) {
    const hoursRaw = Number(amPmMatch[1]);
    const minutes = Number(amPmMatch[2] ?? "0");
    if (Number.isNaN(hoursRaw) || Number.isNaN(minutes) || minutes < 0 || minutes > 59) {
      return null;
    }

    const isPm = amPmMatch[3].toLowerCase() === "pm";
    let hour = hoursRaw % 12;
    if (isPm) {
      hour += 12;
    }
    return { hour, minute: minutes };
  }

  const twentyFourMatch = text.match(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (twentyFourMatch) {
    const hour = Number(twentyFourMatch[1]);
    const minute = Number(twentyFourMatch[2]);
    if (Number.isNaN(hour) || Number.isNaN(minute)) {
      return null;
    }
    return { hour, minute };
  }

  const partOfDay = text.toLowerCase();
  if (/\bmorning\b/.test(partOfDay)) {
    return { hour: 9, minute: 0 };
  }
  if (/\bafternoon\b/.test(partOfDay)) {
    return { hour: 14, minute: 0 };
  }
  if (/\bevening\b/.test(partOfDay)) {
    return { hour: 19, minute: 0 };
  }
  if (/\btonight\b/.test(partOfDay)) {
    return { hour: Math.max(nowInTz.hour, 20), minute: 0 };
  }

  return null;
}

export function resolvePreferredTimeOfDay(
  userMessage: string,
  dueAtIso: string | null,
  timezone: string,
  nowInTz: DateTime
): { hour: number; minute: number } {
  if (dueAtIso) {
    const due = DateTime.fromISO(dueAtIso, { zone: timezone });
    if (due.isValid) {
      return { hour: due.hour, minute: due.minute };
    }
  }

  const parsedFromText = parseTimeOfDayFromText(userMessage, nowInTz);
  if (parsedFromText) {
    return parsedFromText;
  }

  return { hour: 9, minute: 0 };
}

/** Next calendar hit for any of `weekdays` (Luxon 1–7) at hour:minute, strictly after `instant` interpreted in `timezone`. */
export function nextScheduledOccurrenceAfter(
  instant: DateTime,
  timezone: string,
  weekdays: number[],
  hour: number,
  minute: number
): string | null {
  const nowInTz = instant.setZone(timezone);
  const set = new Set(weekdays);
  for (let i = 0; i < 400; i++) {
    const candidate = nowInTz
      .startOf("day")
      .plus({ days: i })
      .set({ hour, minute, second: 0, millisecond: 0 });
    if (candidate <= nowInTz) {
      continue;
    }
    if (set.has(candidate.weekday)) {
      return candidate.toUTC().toISO();
    }
  }
  return null;
}

export function serializeWeeklyRecurrence(payload: WeeklyRecurrenceStored): string {
  const uniqueSorted = [...new Set(payload.weekdays)].sort((a, b) => a - b);
  return JSON.stringify({
    kind: "weekly" as const,
    weekdays: uniqueSorted,
    hour: payload.hour,
    minute: payload.minute
  });
}

export function parseWeeklyRecurrenceJson(json: string | null): WeeklyRecurrenceStored | null {
  if (!json?.trim()) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = weeklyRecurrenceStoredSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function formatWeeklyRecurrenceSummary(json: string | null): string | null {
  const parsed = parseWeeklyRecurrenceJson(json);
  if (!parsed) {
    return null;
  }
  const days = parsed.weekdays.map((d) => WEEKDAY_SHORT[d] ?? "?").join(", ");
  const hm = `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
  return `weekly ${days} ${hm}`;
}
