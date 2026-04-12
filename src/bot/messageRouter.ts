import { DateTime } from "luxon";

import { OpenAiClient } from "../ai/openaiClient";
import { ConversationService } from "../ai/conversationService";
import { IntentParserService } from "../ai/intentParser";
import { env } from "../config/env";
import { RemindersRepository } from "../db/repositories/remindersRepo";
import { TasksRepository } from "../db/repositories/tasksRepo";
import type { ParsedReminderIntent } from "../types/domain";

export class MessageRouter {
  constructor(
    private readonly openAiClient: OpenAiClient,
    private readonly conversationService: ConversationService,
    private readonly intentParser: IntentParserService,
    private readonly remindersRepo: RemindersRepository,
    private readonly tasksRepo: TasksRepository
  ) {}

  async routeTextMessage(params: {
    chatId: number;
    userId: number;
    text: string;
    quotedMessageText?: string;
  }): Promise<string> {
    const trimmedText = params.text.trim();
    if (!trimmedText) {
      return "Please send a message.";
    }

    const quotedRef = extractQuotedReference(params.quotedMessageText);

    if (isAllInfoRequest(trimmedText)) {
      return this.getAllPendingInfo(params.chatId);
    }

    if (isListTasksRequest(trimmedText)) {
      return this.listPendingTasks(params.chatId);
    }

    if (isListRemindersRequest(trimmedText)) {
      return this.listPendingReminders(params.chatId, trimmedText);
    }

    if (isDataQuestionRequest(trimmedText)) {
      return this.answerQuestionFromStoredData(params.chatId, trimmedText);
    }

    if (isAddTaskRequest(trimmedText)) {
      const taskResult = await this.createTasksFromText(params.chatId, params.userId, trimmedText);
      if (taskResult) {
        return taskResult;
      }
      return "I understood this as a task request, but couldn't extract the task details.";
    }

    const adjustRequest = parseAdjustReminderRequest(trimmedText);
    if (adjustRequest) {
      const targetReminderId = await this.resolveTargetReminderId(
        params.chatId,
        adjustRequest.id,
        quotedRef
      );

      if (!targetReminderId) {
        return (
          "I couldn't determine which reminder to adjust. " +
          "Reply to a reminder message or specify an ID like: adjust reminder #3 to in 30 minutes."
        );
      }

      return this.adjustReminderByInstruction(params.chatId, targetReminderId, adjustRequest.instructions);
    }

    const deleteRequest = parseDeleteRequest(trimmedText);
    if (deleteRequest) {
      if (deleteRequest.targetType === "reminder") {
        return this.deleteReminders(params.chatId, deleteRequest, quotedRef);
      }
      return this.deleteTasks(params.chatId, deleteRequest, quotedRef);
    }

    const multiIntents = await this.intentParser.extractMultipleReminderIntents(
      trimmedText,
      env.APP_TIMEZONE
    );
    if (multiIntents.length > 0) {
      const creationResult = await this.createRemindersFromIntents(
        params.chatId,
        params.userId,
        multiIntents
      );
      if (creationResult) {
        return creationResult;
      }
    }

    const intent = await this.intentParser.extractReminderIntent(trimmedText, env.APP_TIMEZONE);
    const likelyReminder = isLikelyReminderRequest(trimmedText);
    const shouldHandleAsReminder = intent.isReminder || likelyReminder;
    const fallbackDueAtIso = inferDefaultDueAtIso(trimmedText, env.APP_TIMEZONE);
    const resolvedDueAtIso = intent.dueAtIso ?? fallbackDueAtIso;

    if (shouldHandleAsReminder && intent.reminderMessage && resolvedDueAtIso) {
      const dueUtc = DateTime.fromISO(resolvedDueAtIso).toUTC();
      if (!dueUtc.isValid) {
        return [
          "⚠️ I couldn't parse the reminder time.",
          "Try: Remind me to check server logs in 2 hours."
        ].join("\n");
      }

      const reminderId = await this.remindersRepo.createReminder({
        chatId: params.chatId,
        userId: params.userId,
        message: intent.reminderMessage,
        dueAtUtc: dueUtc.toISO() ?? new Date().toISOString(),
        timezone: env.APP_TIMEZONE
      });

      const localDue = dueUtc.setZone(env.APP_TIMEZONE).toFormat("dd/LL/yyyy HH:mm");
      return `✅ Reminder saved #${reminderId}: ${intent.reminderMessage} (${localDue})`;
    }

    if (shouldHandleAsReminder) {
      const reason = intent.reason ? `\n• Note: ${intent.reason}` : "";
      return (
        [
          "⚠️ Reminder request detected, but details are incomplete.",
          "Please include what to remind and when.",
          reason,
          "Example: Remind me to check server logs in 2 hours."
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    return this.conversationService.replyToUser(params.chatId, params.userId, trimmedText);
  }

  private async createRemindersFromIntents(
    chatId: number,
    userId: number,
    intents: ParsedReminderIntent[]
  ): Promise<string | null> {
    const validIntents = intents.filter((intent) => intent.reminderMessage && intent.dueAtIso);
    if (validIntents.length === 0) {
      return null;
    }

    const created: Array<{ id: number; message: string; localDue: string }> = [];

    for (const intent of validIntents) {
      const dueUtc = DateTime.fromISO(intent.dueAtIso as string).toUTC();
      if (!dueUtc.isValid) {
        continue;
      }

      const reminderId = await this.remindersRepo.createReminder({
        chatId,
        userId,
        message: intent.reminderMessage as string,
        dueAtUtc: dueUtc.toISO() ?? new Date().toISOString(),
        timezone: env.APP_TIMEZONE
      });
      const localDue = dueUtc.setZone(env.APP_TIMEZONE).toFormat("dd/LL/yyyy HH:mm");
      created.push({ id: reminderId, message: intent.reminderMessage as string, localDue });
    }

    if (created.length === 0) {
      return null;
    }

    if (created.length === 1) {
      const one = created[0];
      return `✅ Reminder saved #${one.id}: ${one.message} (${one.localDue})`;
    }

    const lines = created.map((item) => `• #${item.id}: ${item.message} (${item.localDue})`);
    return [`✅ ${created.length} reminders saved`, ...lines].join("\n");
  }

  private async listPendingReminders(chatId: number, userMessage?: string): Promise<string> {
    const reminders = await this.remindersRepo.getPendingRemindersByChat(chatId, 20);
    if (reminders.length === 0) {
      return "You have no pending reminders.";
    }

    const filteredReminders = await this.applyReminderListFilter(reminders, userMessage);
    if (filteredReminders.length === 0) {
      return "No pending reminders match your filter.";
    }

    const lines = filteredReminders.map((reminder, index) => {
      const dueLocal = DateTime.fromISO(reminder.dueAtUtc, { zone: "utc" })
        .setZone(env.APP_TIMEZONE)
        .toFormat("dd/LL/yyyy HH:mm");
      return [`${index + 1}. ${reminder.message}`, `${dueLocal}`, "--------------------"].join("\n");
    });

    return [`📌 Pending reminders (${filteredReminders.length})`, "", ...lines].join("\n");
  }

  private async listPendingTasks(chatId: number): Promise<string> {
    const tasks = await this.tasksRepo.getPendingTasksByChat(chatId, 50);
    if (tasks.length === 0) {
      return "You have no pending tasks.";
    }

    const lines = tasks.map((task, index) =>
      [`${index + 1}. ${task.task}`, "--------------------"].join("\n")
    );
    return [`🗂️ Pending tasks (${tasks.length})`, "", ...lines].join("\n");
  }

  private async getAllPendingInfo(chatId: number): Promise<string> {
    const [reminders, tasks] = await Promise.all([
      this.remindersRepo.getPendingRemindersByChat(chatId, 20),
      this.tasksRepo.getPendingTasksByChat(chatId, 50)
    ]);

    const reminderLines =
      reminders.length === 0
        ? ["• No pending reminders"]
        : reminders.map((reminder) => {
            const dueLocal = DateTime.fromISO(reminder.dueAtUtc, { zone: "utc" })
              .setZone(env.APP_TIMEZONE)
              .toFormat("dd/LL/yyyy HH:mm");
            return `• #${reminder.id}: ${reminder.message} (${dueLocal})`;
          });

    const taskLines =
      tasks.length === 0
        ? ["• No pending tasks"]
        : tasks.map((task) => `• #${task.id}: ${task.task}`);

    return ["📋 Your info", "", "Reminders:", ...reminderLines, "", "Tasks:", ...taskLines].join(
      "\n"
    );
  }

  private async createTasksFromText(
    chatId: number,
    userId: number,
    userText: string
  ): Promise<string | null> {
    const aiTasks = await this.intentParser.extractMultipleTaskItems(userText);
    const heuristicTasks = extractTasksHeuristic(userText);
    // Prefer AI extraction when available; fallback to heuristic only when AI found nothing.
    const selectedTasks = (aiTasks.length > 0 ? aiTasks : heuristicTasks)
      .map((task) => task.trim())
      .filter(Boolean);

    if (selectedTasks.length === 0) {
      return null;
    }

    const dedupedByNormalized = new Map<string, string>();
    for (const task of selectedTasks) {
      const normalizedKey = normalizeTaskForDedup(task);
      if (!normalizedKey) {
        continue;
      }
      if (!dedupedByNormalized.has(normalizedKey)) {
        dedupedByNormalized.set(normalizedKey, task);
      }
    }

    const uniqueTasks = Array.from(dedupedByNormalized.values());
    if (uniqueTasks.length === 0) {
      return null;
    }

    const created: Array<{ id: number; task: string }> = [];
    for (const task of uniqueTasks) {
      const id = await this.tasksRepo.createTask({ chatId, userId, task });
      created.push({ id, task });
    }

    if (created.length === 1) {
      return `✅ Task added #${created[0].id}: ${created[0].task}`;
    }

    const lines = created.map((item) => `• #${item.id}: ${item.task}`);
    return [`✅ ${created.length} tasks added`, ...lines].join("\n");
  }

  private async answerQuestionFromStoredData(chatId: number, question: string): Promise<string> {
    const [reminders, tasks] = await Promise.all([
      this.remindersRepo.getPendingRemindersByChat(chatId, 100),
      this.tasksRepo.getPendingTasksByChat(chatId, 100)
    ]);

    if (reminders.length === 0 && tasks.length === 0) {
      return "You currently have no pending reminders or tasks.";
    }

    try {
      return await this.openAiClient.answerQuestionWithData({
        question,
        reminders,
        tasks
      });
    } catch (error) {
      console.error("Failed to answer data question:", error);
      return "I couldn't read your reminders/tasks data right now. Please try again.";
    }
  }

  private async adjustReminderByInstruction(
    chatId: number,
    reminderId: number,
    instructions: string
  ): Promise<string> {
    const existingReminder = await this.remindersRepo.getPendingReminderById(chatId, reminderId);
    if (!existingReminder) {
      return `I couldn't find a pending reminder with ID #${reminderId}.`;
    }

    const primaryIntent = await this.intentParser.extractReminderIntent(instructions, env.APP_TIMEZONE);
    const fallbackIntent = await this.intentParser.extractReminderIntent(
      `Remind me to ${instructions}`,
      env.APP_TIMEZONE
    );
    const parsedIntent =
      primaryIntent.reminderMessage || primaryIntent.dueAtIso || primaryIntent.isReminder
        ? primaryIntent
        : fallbackIntent;

    let updatedDueAtUtc = existingReminder.dueAtUtc;
    if (parsedIntent.dueAtIso) {
      const dueUtc = DateTime.fromISO(parsedIntent.dueAtIso).toUTC();
      if (!dueUtc.isValid) {
        return "I couldn't parse the new reminder time. Try: adjust reminder #3 to in 30 minutes.";
      }
      updatedDueAtUtc = dueUtc.toISO() ?? existingReminder.dueAtUtc;
    }

    const updatedMessage = parsedIntent.reminderMessage?.trim() || existingReminder.message;
    if (!updatedMessage) {
      return "I couldn't determine the updated reminder task. Please include the task text.";
    }

    await this.remindersRepo.updatePendingReminder(reminderId, {
      message: updatedMessage,
      dueAtUtc: updatedDueAtUtc
    });

    return `✅ Reminder updated #${reminderId}: ${updatedMessage}`;
  }

  private async deleteReminders(
    chatId: number,
    request: DeleteRequest,
    quotedRef: QuotedReference | null
  ): Promise<string> {
    if (request.mode === "all") {
      const deletedCount = await this.remindersRepo.cancelAllPendingRemindersByChat(chatId);
      return deletedCount > 0
        ? `🗑️ Deleted ${deletedCount} reminder(s).`
        : "You have no pending reminders to delete.";
    }

    const pendingReminders = await this.remindersRepo.getPendingRemindersByChat(chatId, 200);
    const pendingById = new Map(pendingReminders.map((item) => [item.id, item]));

    let targetIds: number[] = [];

    if (request.mode === "single" && request.ids.length === 1) {
      targetIds = [request.ids[0]];
    } else if (request.mode === "count" && request.count) {
      targetIds = pendingReminders.slice(0, request.count).map((item) => item.id);
    } else if (request.mode === "ids" && request.ids.length > 0) {
      targetIds = request.ids;
    } else {
      const resolvedId = await this.resolveTargetReminderId(chatId, undefined, quotedRef);
      if (resolvedId) {
        targetIds = [resolvedId];
      }
    }

    const uniqueIds = Array.from(new Set(targetIds));
    const deleted: number[] = [];

    for (const id of uniqueIds) {
      if (!pendingById.has(id)) {
        continue;
      }
      await this.remindersRepo.cancelPendingReminder(id);
      deleted.push(id);
    }

    if (deleted.length === 0) {
      return "I couldn't find matching pending reminders to delete.";
    }

    if (deleted.length === 1) {
      const one = pendingById.get(deleted[0]);
      return `🗑️ Reminder deleted #${deleted[0]}: ${one?.message ?? "deleted"}`;
    }

    return `🗑️ Deleted ${deleted.length} reminder(s): ${deleted.map((id) => `#${id}`).join(", ")}`;
  }

  private async deleteTasks(
    chatId: number,
    request: DeleteRequest,
    quotedRef: QuotedReference | null
  ): Promise<string> {
    if (request.mode === "all") {
      const deletedCount = await this.tasksRepo.cancelAllPendingTasksByChat(chatId);
      return deletedCount > 0 ? `🗑️ Deleted ${deletedCount} task(s).` : "You have no pending tasks to delete.";
    }

    const pendingTasks = await this.tasksRepo.getPendingTasksByChat(chatId, 200);
    const pendingById = new Map(pendingTasks.map((item) => [item.id, item]));

    let targetIds: number[] = [];

    if (request.mode === "single" && request.ids.length === 1) {
      targetIds = [request.ids[0]];
    } else if (request.mode === "count" && request.count) {
      targetIds = pendingTasks.slice(0, request.count).map((item) => item.id);
    } else if (request.mode === "ids" && request.ids.length > 0) {
      targetIds = request.ids;
    } else {
      const resolvedId = await this.resolveTargetTaskId(chatId, undefined, quotedRef);
      if (resolvedId) {
        targetIds = [resolvedId];
      }
    }

    const uniqueIds = Array.from(new Set(targetIds));
    const deleted: number[] = [];

    for (const id of uniqueIds) {
      if (!pendingById.has(id)) {
        continue;
      }
      await this.tasksRepo.cancelPendingTask(id);
      deleted.push(id);
    }

    if (deleted.length === 0) {
      return "I couldn't find matching pending tasks to delete.";
    }

    if (deleted.length === 1) {
      const one = pendingById.get(deleted[0]);
      return `🗑️ Task deleted #${deleted[0]}: ${one?.task ?? "deleted"}`;
    }

    return `🗑️ Deleted ${deleted.length} task(s): ${deleted.map((id) => `#${id}`).join(", ")}`;
  }

  private async resolveTargetReminderId(
    chatId: number,
    explicitId: number | undefined,
    quotedRef: QuotedReference | null
  ): Promise<number | null> {
    if (explicitId && explicitId > 0) {
      return explicitId;
    }

    if (quotedRef?.id && quotedRef.id > 0) {
      return quotedRef.id;
    }

    if (quotedRef?.task) {
      const reminder = await this.remindersRepo.getLatestPendingReminderByMessage(chatId, quotedRef.task);
      return reminder?.id ?? null;
    }

    return null;
  }

  private async resolveTargetTaskId(
    chatId: number,
    explicitId: number | undefined,
    quotedRef: QuotedReference | null
  ): Promise<number | null> {
    if (explicitId && explicitId > 0) {
      return explicitId;
    }

    if (quotedRef?.id && quotedRef.id > 0) {
      return quotedRef.id;
    }

    if (quotedRef?.task) {
      const task = await this.tasksRepo.getLatestPendingTaskByText(chatId, quotedRef.task);
      return task?.id ?? null;
    }

    return null;
  }

  private async applyReminderListFilter(
    reminders: Array<{ message: string; dueAtUtc: string }>,
    userMessage?: string
  ): Promise<Array<{ message: string; dueAtUtc: string }>> {
    const request = userMessage?.trim() ?? "";
    if (!request || isPlainReminderListRequest(request)) {
      return reminders;
    }

    const nowLocal = DateTime.now().setZone(env.APP_TIMEZONE);
    const parsed = await this.openAiClient.parseReminderListFilter({
      userMessage: request,
      timezone: env.APP_TIMEZONE,
      nowIsoInTimezone: nowLocal.toISO() ?? nowLocal.toString()
    });

    let filtered = reminders;

    if (parsed.dateMode === "today") {
      const today = nowLocal.toFormat("yyyy-LL-dd");
      filtered = filtered.filter((item) => {
        const local = DateTime.fromISO(item.dueAtUtc, { zone: "utc" }).setZone(env.APP_TIMEZONE);
        return local.toFormat("yyyy-LL-dd") === today;
      });
    } else if (parsed.dateMode === "tomorrow") {
      const tomorrow = nowLocal.plus({ days: 1 }).toFormat("yyyy-LL-dd");
      filtered = filtered.filter((item) => {
        const local = DateTime.fromISO(item.dueAtUtc, { zone: "utc" }).setZone(env.APP_TIMEZONE);
        return local.toFormat("yyyy-LL-dd") === tomorrow;
      });
    } else if (parsed.dateMode === "specific_date" && parsed.specificDate) {
      filtered = filtered.filter((item) => {
        const local = DateTime.fromISO(item.dueAtUtc, { zone: "utc" }).setZone(env.APP_TIMEZONE);
        return local.toFormat("yyyy-LL-dd") === parsed.specificDate;
      });
    }

    if (parsed.keyword) {
      const keyword = parsed.keyword.toLowerCase();
      filtered = filtered.filter((item) => item.message.toLowerCase().includes(keyword));
    }

    return filtered;
  }
}

interface QuotedReference {
  id?: number;
  task?: string;
}

type DeleteTargetType = "reminder" | "task";
type DeleteMode = "single" | "ids" | "count" | "all";

interface DeleteRequest {
  targetType: DeleteTargetType;
  mode: DeleteMode;
  ids: number[];
  count?: number;
}

function isLikelyReminderRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  const keywordPattern = /\b(remind|reminder|notify|notification)\b/i;
  const relativeTimePattern =
    /\b(in\s+\d+\s+(second|seconds|minute|minutes|hour|hours|day|days)|tomorrow|today|tonight)\b/i;
  const clockPattern = /\b(at\s+\d{1,2}(:\d{2})?\s*(am|pm)?)\b/i;

  return (
    keywordPattern.test(normalized) ||
    relativeTimePattern.test(normalized) ||
    clockPattern.test(normalized)
  );
}

function inferDefaultDueAtIso(text: string, timezone: string): string | null {
  const normalized = text.toLowerCase();

  // If user already gave explicit time-like details, do not force a default.
  const hasExplicitClock = /\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\bat\s+\d{1,2}(:\d{2})?\b/i.test(normalized);
  const hasRelativeDuration =
    /\b(in|after)\s+\d+\s+(second|seconds|minute|minutes|hour|hours|day|days)\b/i.test(normalized);
  if (hasExplicitClock || hasRelativeDuration) {
    return null;
  }

  const now = DateTime.now().setZone(timezone);
  const defaultHour = 9;
  const defaultMinute = 0;

  if (/\btomorrow\b/i.test(normalized)) {
    return now.plus({ days: 1 }).set({ hour: defaultHour, minute: defaultMinute, second: 0, millisecond: 0 }).toISO();
  }

  if (/\btoday\b/i.test(normalized)) {
    const todayAtDefault = now.set({
      hour: defaultHour,
      minute: defaultMinute,
      second: 0,
      millisecond: 0
    });
    return (todayAtDefault > now ? todayAtDefault : now.plus({ days: 1 }).set({
      hour: defaultHour,
      minute: defaultMinute,
      second: 0,
      millisecond: 0
    })).toISO();
  }

  // Generic reminder request without a clear time/date -> schedule for tomorrow at 9:00 AM.
  if (/\b(remind|reminder|notify|notification)\b/i.test(normalized)) {
    return now.plus({ days: 1 }).set({ hour: defaultHour, minute: defaultMinute, second: 0, millisecond: 0 }).toISO();
  }

  return null;
}

function isListRemindersRequest(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  return /\b(show|list|view|see|display|what)\b.*\b(reminder|reminders)\b/i.test(normalized);
}

function isListTasksRequest(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  return /\b(show|list|view|see|display|what)\b.*\b(task|tasks|todo|to-do)\b/i.test(normalized);
}

function isAllInfoRequest(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  return (
    /\b(all|everything|full)\b.*\b(info|information|status)\b/i.test(normalized) ||
    (/(\btask|tasks|todo|to-do\b)/i.test(normalized) &&
      /\b(reminder|reminders)\b/i.test(normalized) &&
      /\b(show|list|view|see|display|what)\b/i.test(normalized))
  );
}

function isDataQuestionRequest(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  const hasDataWords = /\b(reminder|reminders|task|tasks|todo|to-do)\b/i.test(normalized);
  const hasQuestionStyle =
    /\?/.test(normalized) ||
    /\b(what|which|when|where|how many|do i have|is there|are there|tell me)\b/i.test(normalized);
  const isActionCommand =
    isAddTaskRequest(normalized) ||
    isListTasksRequest(normalized) ||
    isListRemindersRequest(normalized) ||
    isAllInfoRequest(normalized) ||
    parseAdjustReminderRequest(normalized) !== null ||
    parseDeleteRequest(normalized) !== null;

  return hasDataWords && hasQuestionStyle && !isActionCommand;
}

function isAddTaskRequest(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  return (
    /\b(add|create|insert|save)\b.*\b(task|tasks|todo|to-do)\b/i.test(normalized) ||
    /\bto my tasks\b/i.test(normalized) ||
    /\bmy tasks\b.*:/i.test(normalized)
  );
}

function parseAdjustReminderRequest(
  text: string
): { id?: number; instructions: string } | null {
  const match = text.match(
    /(?:adjust|update|change|edit)(?:\s+(?:reminder\s*)?#?(\d+))?\s*(?:to|:)?\s*(.+)$/i
  );

  if (!match) {
    return null;
  }

  const rawId = match[1];
  const instructions = match[2].trim();
  const id = rawId ? Number.parseInt(rawId, 10) : undefined;

  if ((id !== undefined && (!Number.isFinite(id) || id <= 0)) || !instructions) {
    return null;
  }

  return { id, instructions };
}

function parseDeleteRequest(text: string): DeleteRequest | null {
  const normalized = text.toLowerCase().trim();
  if (!/\b(delete|remove|cancel)\b/i.test(normalized)) {
    return null;
  }

  const reminderMentioned = /\breminder|reminders\b/i.test(normalized);
  const taskMentioned = /\btask|tasks|todo|to-do\b/i.test(normalized);
  const targetType: DeleteTargetType | null = reminderMentioned
    ? "reminder"
    : taskMentioned
      ? "task"
      : null;

  if (!targetType) {
    return null;
  }

  if (/\b(delete|remove|cancel)\s+all\s+(?:my\s+)?(?:reminders?|tasks?|todo|to-do)\b/i.test(normalized)) {
    return { targetType, mode: "all", ids: [] };
  }

  const countMatch = normalized.match(
    /\b(delete|remove|cancel)\s+(\d+)\s+(?:my\s+)?(?:reminders?|tasks?|todo|to-do)\b/i
  );
  if (countMatch) {
    const count = Number.parseInt(countMatch[2], 10);
    if (Number.isFinite(count) && count > 0) {
      return { targetType, mode: "count", ids: [], count };
    }
  }

  const allNumbers = Array.from(normalized.matchAll(/#?(\d+)/g))
    .map((match) => Number.parseInt(match[1], 10))
    .filter((value) => Number.isFinite(value) && value > 0);

  const uniqueIds = Array.from(new Set(allNumbers));
  if (uniqueIds.length > 1) {
    return { targetType, mode: "ids", ids: uniqueIds };
  }

  if (uniqueIds.length === 1 && /#/.test(normalized)) {
    return { targetType, mode: "single", ids: uniqueIds };
  }

  if (uniqueIds.length === 1 && /\b(reminder|task|todo|to-do)\b/i.test(normalized)) {
    return { targetType, mode: "single", ids: uniqueIds };
  }

  return { targetType, mode: "single", ids: [] };
}

function extractTasksHeuristic(text: string): string[] {
  const normalized = text.trim();

  const taskListMatch = normalized.match(
    /(?:add|create|insert|save)\s+(?:to\s+my\s+)?(?:tasks?|todo|to-do)\s*(?::|,|that|these)?\s*(.+)$/i
  );
  const payload = taskListMatch?.[1]?.trim();
  if (!payload) {
    return [];
  }

  return payload
    .split(/\s*(?:,| and |;)\s*/i)
    .map((part) => part.trim().replace(/^\d+[\).\s-]+/, ""))
    .filter(Boolean);
}

function normalizeTaskForDedup(task: string): string {
  return task.toLowerCase().replace(/\s+/g, " ").trim();
}

function extractQuotedReference(quotedText?: string): QuotedReference | null {
  if (!quotedText) {
    return null;
  }

  const idMatch = quotedText.match(/#(\d+)/);
  const reminderTaskMatch = quotedText.match(/Reminder:\s*(.+)$/i);
  const listTaskMatch = quotedText.match(/#\d+\s*-\s*(.+)$/i);

  const id = idMatch ? Number.parseInt(idMatch[1], 10) : undefined;
  const task = reminderTaskMatch?.[1]?.trim() || listTaskMatch?.[1]?.trim();

  if (!id && !task) {
    return null;
  }

  return {
    id: id && Number.isFinite(id) ? id : undefined,
    task: task || undefined
  };
}

function isPlainReminderListRequest(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  return (
    normalized === "show reminders" ||
    normalized === "list reminders" ||
    normalized === "my reminders" ||
    normalized === "pending reminders"
  );
}
