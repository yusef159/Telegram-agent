import { DateTime } from "luxon";

import type {
  MessageActionPlan,
  MessageActionPlanNormalizationResult,
  ParsedReminderIntent,
  PlannedAction,
  PlannedDeleteNewsSubscriptionAction,
  PlannedCreateReminderAction,
  PlannedSetNewsSubscriptionAction
} from "../types/domain";
import {
  extractMentionedWeekdays,
  impliesWeeklyRecurrenceInUserText,
  nextScheduledOccurrenceAfter,
  resolvePreferredTimeOfDay
} from "../reminders/weeklyRecurrence";
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

  /**
   * When the user asks for weekly repetition (e.g. "every Sunday"), attach recurrence metadata
   * and align the first fire to the next matching weekday.
   */
  applyWeeklyRecurrenceFromUserText(
    userMessage: string,
    intent: ParsedReminderIntent,
    timezone: string
  ): ParsedReminderIntent {
    if (!impliesWeeklyRecurrenceInUserText(userMessage) || intent.weeklyRecurrence) {
      return intent;
    }
    if (!intent.isReminder) {
      return intent;
    }

    const weekdays = extractMentionedWeekdays(userMessage);
    const reminderMessage = intent.reminderMessage?.trim();
    if (weekdays.length < 1 || !reminderMessage) {
      return intent;
    }

    const nowInTz = DateTime.now().setZone(timezone);
    const timeOfDay = resolvePreferredTimeOfDay(userMessage, intent.dueAtIso, timezone, nowInTz);
    const firstDue = nextScheduledOccurrenceAfter(
      nowInTz,
      timezone,
      weekdays,
      timeOfDay.hour,
      timeOfDay.minute
    );
    if (!firstDue) {
      return intent;
    }

    return normalizeReminderIntent(
      {
        ...intent,
        isReminder: true,
        reminderMessage,
        dueAtIso: firstDue,
        weeklyRecurrence: {
          weekdays,
          hour: timeOfDay.hour,
          minute: timeOfDay.minute
        }
      },
      timezone,
      nowInTz
    );
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

    const normalized = parsed
      .filter((intent) => intent.isReminder)
      .map((intent) => normalizeReminderIntent(intent, timezone, nowInTz));

    const expanded = expandWeekdayListIntoMultipleReminders(userMessage, normalized, nowInTz, timezone);
    return dedupeReminderIntents(expanded);
  }

  async extractMultipleTaskItems(userMessage: string): Promise<string[]> {
    return this.openAiClient.parseMultipleTaskItems({ userMessage });
  }

  async normalizeMessageActionPlan(
    userMessage: string,
    timezone: string
  ): Promise<MessageActionPlanNormalizationResult> {
    const nowInTz = DateTime.now().setZone(timezone);
    const plannerResult = await this.openAiClient.planMessageActions({
      userMessage,
      timezone,
      nowIsoInTimezone: nowInTz.toISO() ?? nowInTz.toString()
    });

    if (!plannerResult.plan) {
      return {
        ...plannerResult,
        normalizationErrors: []
      };
    }

    const normalizationErrors: string[] = [];
    const normalizedActions: PlannedAction[] = [];

    for (let index = 0; index < plannerResult.plan.actions.length; index += 1) {
      const action = plannerResult.plan.actions[index];
      const normalizedAction = normalizePlannedAction(action, timezone, nowInTz, normalizationErrors, index);
      if (normalizedAction) {
        normalizedActions.push(normalizedAction);
      }
    }

    if (normalizedActions.length > 10) {
      normalizationErrors.push("actions: Planner exceeded hard limit of 10 actions.");
    }

    const hasClarificationAction = normalizedActions.some((action) => action.type === "ask_clarification");
    const needsClarification = plannerResult.plan.needsClarification || hasClarificationAction;
    const clarificationQuestion =
      plannerResult.plan.clarificationQuestion?.trim() ||
      (hasClarificationAction
        ? normalizedActions.find((action) => action.type === "ask_clarification")?.question
        : null);

    if (needsClarification && !clarificationQuestion) {
      normalizationErrors.push("clarificationQuestion: Missing clarification question.");
    }

    const normalizedPlan: MessageActionPlan = {
      ...plannerResult.plan,
      actions: normalizedActions,
      needsClarification,
      clarificationQuestion: clarificationQuestion ?? null
    };

    return {
      rawOutput: plannerResult.rawOutput,
      plan: normalizationErrors.length > 0 ? null : normalizedPlan,
      validationErrors: plannerResult.validationErrors,
      normalizationErrors
    };
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

function expandWeekdayListIntoMultipleReminders(
  userMessage: string,
  intents: ParsedReminderIntent[],
  nowInTz: DateTime,
  timezone: string
): ParsedReminderIntent[] {
  const weekdays = extractMentionedWeekdays(userMessage);

  if (impliesWeeklyRecurrenceInUserText(userMessage) && weekdays.length >= 1 && intents.length >= 1) {
    const baseIntent = intents[0];
    const reminderMessage = baseIntent.reminderMessage?.trim();
    if (!reminderMessage) {
      return intents;
    }

    const timeOfDay = resolvePreferredTimeOfDay(
      userMessage,
      baseIntent.dueAtIso,
      timezone,
      nowInTz
    );
    const firstDue = nextScheduledOccurrenceAfter(
      nowInTz,
      timezone,
      weekdays,
      timeOfDay.hour,
      timeOfDay.minute
    );
    if (!firstDue) {
      return intents;
    }

    return [
      normalizeReminderIntent(
        {
          ...baseIntent,
          isReminder: true,
          reminderMessage,
          dueAtIso: firstDue,
          weeklyRecurrence: {
            weekdays,
            hour: timeOfDay.hour,
            minute: timeOfDay.minute
          },
          reason: baseIntent.reason ?? "Weekly recurring reminder on listed weekdays."
        },
        timezone,
        nowInTz
      )
    ];
  }

  if (weekdays.length < 2 || intents.length !== 1) {
    return intents;
  }

  const baseIntent = intents[0];
  const reminderMessage = baseIntent.reminderMessage?.trim();
  if (!reminderMessage) {
    return intents;
  }

  const timeOfDay = resolvePreferredTimeOfDay(userMessage, baseIntent.dueAtIso, timezone, nowInTz);
  const expanded = weekdays.map((weekday) => ({
    ...baseIntent,
    weeklyRecurrence: undefined,
    dueAtIso: nextScheduledOccurrenceAfter(
      nowInTz,
      timezone,
      [weekday],
      timeOfDay.hour,
      timeOfDay.minute
    ),
    reason: baseIntent.reason ?? "Expanded weekday-list reminder into one reminder per weekday."
  }));

  return expanded.map((intent) => normalizeReminderIntent(intent, timezone, nowInTz));
}

function dedupeReminderIntents(intents: ParsedReminderIntent[]): ParsedReminderIntent[] {
  const unique = new Map<string, ParsedReminderIntent>();
  for (const intent of intents) {
    const recKey = intent.weeklyRecurrence
      ? `rec:${[...intent.weeklyRecurrence.weekdays].sort((a, b) => a - b).join(",")}-${intent.weeklyRecurrence.hour}-${intent.weeklyRecurrence.minute}`
      : "";
    const key = `${intent.reminderMessage ?? ""}|${intent.dueAtIso ?? ""}|${recKey}`;
    if (!unique.has(key)) {
      unique.set(key, intent);
    }
  }
  return [...unique.values()];
}

function normalizePlannedAction(
  action: PlannedAction,
  timezone: string,
  nowInTz: DateTime,
  normalizationErrors: string[],
  actionIndex: number
): PlannedAction | null {
  switch (action.type) {
    case "create_reminder":
      return normalizeCreateReminderAction(action, timezone, nowInTz, normalizationErrors, actionIndex);
    case "create_task":
      if (!action.task.trim()) {
        normalizationErrors.push(`actions.${actionIndex}.task: Task text is empty.`);
        return null;
      }
      return {
        ...action,
        task: action.task.trim()
      };
    case "answer_user":
      if (!action.text.trim()) {
        normalizationErrors.push(`actions.${actionIndex}.text: Answer text is empty.`);
        return null;
      }
      return {
        ...action,
        text: action.text.trim()
      };
    case "fetch_news": {
      const topic = action.topic?.trim() || null;
      const maxItems =
        typeof action.maxItems === "number" && Number.isFinite(action.maxItems)
          ? Math.max(1, Math.min(10, Math.trunc(action.maxItems)))
          : null;
      return {
        ...action,
        topic,
        maxItems
      };
    }
    case "set_news_subscription":
      return normalizeSetNewsSubscriptionAction(action, normalizationErrors, actionIndex);
    case "show_news_subscription":
      return action;
    case "delete_news_subscription":
      return normalizeDeleteNewsSubscriptionAction(action, normalizationErrors, actionIndex);
    case "list_reminders":
      return {
        ...action,
        filter: action.filter?.trim() || null
      };
    case "list_tasks":
      return action;
    case "delete_reminder":
    case "delete_task":
      return normalizeDeleteAction(action, normalizationErrors, actionIndex);
    case "adjust_reminder":
      if (!action.instructions.trim()) {
        normalizationErrors.push(`actions.${actionIndex}.instructions: Missing adjustment instructions.`);
        return null;
      }
      if (action.id !== null && action.id !== undefined && action.id <= 0) {
        normalizationErrors.push(`actions.${actionIndex}.id: Reminder id must be positive.`);
        return null;
      }
      return {
        ...action,
        instructions: action.instructions.trim()
      };
    case "ask_clarification":
      if (!action.question.trim()) {
        normalizationErrors.push(`actions.${actionIndex}.question: Clarification question is empty.`);
        return null;
      }
      return {
        ...action,
        question: action.question.trim()
      };
    default:
      normalizationErrors.push(`actions.${actionIndex}.type: Unsupported action type.`);
      return null;
  }
}

function normalizeCreateReminderAction(
  action: PlannedCreateReminderAction,
  timezone: string,
  nowInTz: DateTime,
  normalizationErrors: string[],
  actionIndex: number
): PlannedCreateReminderAction | null {
  const message = action.message.trim();
  if (!message) {
    normalizationErrors.push(`actions.${actionIndex}.message: Reminder message is empty.`);
    return null;
  }

  const dueLocal = DateTime.fromISO(action.dueAtIso, { zone: timezone });
  if (!dueLocal.isValid) {
    normalizationErrors.push(`actions.${actionIndex}.dueAtIso: Invalid ISO date.`);
    return null;
  }
  if (dueLocal <= nowInTz) {
    normalizationErrors.push(`actions.${actionIndex}.dueAtIso: Reminder time must be in the future.`);
    return null;
  }

  const recurrence = action.recurrence
    ? {
        ...action.recurrence,
        weekdays: [...new Set(action.recurrence.weekdays)].sort((a, b) => a - b)
      }
    : null;

  if (recurrence && recurrence.weekdays.length < 1) {
    normalizationErrors.push(`actions.${actionIndex}.recurrence.weekdays: At least one weekday is required.`);
    return null;
  }

  return {
    ...action,
    message,
    dueAtIso: dueLocal.toISO() ?? action.dueAtIso,
    recurrence
  };
}

function normalizeDeleteAction<
  T extends PlannedAction & {
    mode: "single" | "ids" | "count" | "all";
    ids?: number[];
    count?: number;
    queryText?: string | null;
    listPosition?: number | null;
  }
>(
  action: T,
  normalizationErrors: string[],
  actionIndex: number
): T | null {
  if (action.mode === "all") {
    return {
      ...action,
      ids: []
    };
  }

  if (action.mode === "count") {
    if (!action.count || action.count <= 0) {
      normalizationErrors.push(`actions.${actionIndex}.count: Count mode requires positive count.`);
      return null;
    }
    return {
      ...action,
      ids: []
    };
  }

  if (action.mode === "single") {
    const queryText = action.queryText?.trim();
    const listPosition = action.listPosition ?? undefined;
    const uniqueIds = Array.from(new Set((action.ids ?? []).filter((id) => id > 0)));
    if (uniqueIds.length < 1 && !queryText && !listPosition) {
      normalizationErrors.push(
        `actions.${actionIndex}: single delete requires id, queryText, or listPosition.`
      );
      return null;
    }
    if (listPosition !== undefined && listPosition <= 0) {
      normalizationErrors.push(`actions.${actionIndex}.listPosition: Must be a positive integer.`);
      return null;
    }
    return {
      ...action,
      ids: uniqueIds,
      queryText: queryText || undefined,
      listPosition
    };
  }

  const uniqueIds = Array.from(new Set((action.ids ?? []).filter((id) => id > 0)));
  if (uniqueIds.length < 1) {
    normalizationErrors.push(`actions.${actionIndex}.ids: At least one id is required for mode ${action.mode}.`);
    return null;
  }

  return {
    ...action,
    ids: uniqueIds
  };
}

function normalizeSetNewsSubscriptionAction(
  action: PlannedSetNewsSubscriptionAction,
  normalizationErrors: string[],
  actionIndex: number
): PlannedSetNewsSubscriptionAction | null {
  const topic = action.topic.trim();
  if (!topic) {
    normalizationErrors.push(`actions.${actionIndex}.topic: News topic is required.`);
    return null;
  }
  if (!Number.isInteger(action.hour) || action.hour < 0 || action.hour > 23) {
    normalizationErrors.push(`actions.${actionIndex}.hour: Must be 0-23.`);
    return null;
  }
  if (!Number.isInteger(action.minute) || action.minute < 0 || action.minute > 59) {
    normalizationErrors.push(`actions.${actionIndex}.minute: Must be 0-59.`);
    return null;
  }
  return {
    ...action,
    topic
  };
}

function normalizeDeleteNewsSubscriptionAction(
  action: PlannedDeleteNewsSubscriptionAction,
  normalizationErrors: string[],
  actionIndex: number
): PlannedDeleteNewsSubscriptionAction | null {
  const topic = action.topic?.trim() || null;
  const id = action.id ?? null;
  const all = Boolean(action.all);

  if (id !== null && (!Number.isInteger(id) || id <= 0)) {
    normalizationErrors.push(`actions.${actionIndex}.id: News subscription id must be positive.`);
    return null;
  }

  if (!all && id === null && !topic) {
    normalizationErrors.push(
      `actions.${actionIndex}: delete_news_subscription requires id, topic, or all=true.`
    );
    return null;
  }

  return {
    ...action,
    id,
    topic,
    all
  };
}
