import { DateTime } from "luxon";
import { createHash } from "node:crypto";

import { OpenAiClient } from "../ai/openaiClient";
import { ConversationService } from "../ai/conversationService";
import { IntentParserService } from "../ai/intentParser";
import { env } from "../config/env";
import { RemindersRepository } from "../db/repositories/remindersRepo";
import { TasksRepository } from "../db/repositories/tasksRepo";
import {
  formatWeeklyRecurrenceSummary,
  serializeWeeklyRecurrence
} from "../reminders/weeklyRecurrence";
import type {
  MessageActionPlan,
  ParsedReminderIntent,
  PlannedAction,
  PlannedDeleteReminderAction,
  PlannedDeleteTaskAction,
  ReminderRecord
} from "../types/domain";

export class MessageRouter {
  private static readonly PLAN_DEDUP_TTL_MS = 90_000;
  private static readonly recentPlanFingerprints = new Map<string, number>();
  private static readonly recentReminderListByChat = new Map<number, { ids: number[]; createdAt: number }>();
  private static readonly recentTaskListByChat = new Map<number, { ids: number[]; createdAt: number }>();
  private static readonly LIST_CONTEXT_TTL_MS = 30 * 60 * 1000;

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
    const startedAt = Date.now();
    const trimmedText = params.text.trim();
    if (!trimmedText) {
      return "Please send a message.";
    }

    if (!env.ACTION_PLANNER_ENABLED) {
      return this.routeTextMessageLegacy(params, trimmedText);
    }

    let plannerOutputRaw: string | null = null;
    let validationErrors: string[] = [];
    let normalizationErrors: string[] = [];
    let plan: MessageActionPlan | null = null;

    try {
      const normalized = await this.intentParser.normalizeMessageActionPlan(trimmedText, env.APP_TIMEZONE);
      plannerOutputRaw = normalized.rawOutput;
      validationErrors = normalized.validationErrors;
      normalizationErrors = normalized.normalizationErrors;
      plan = normalized.plan;
    } catch (error) {
      validationErrors = [
        `Planner invocation failed: ${error instanceof Error ? error.message : "Unknown planner failure"}`
      ];
    }

    if (!plan) {
      this.logPlannerTelemetry({
        stage: "planner_invalid",
        chatId: params.chatId,
        userId: params.userId,
        rawUserInput: trimmedText,
        plannerOutput: plannerOutputRaw,
        validationErrors,
        normalizationErrors,
        executedActionTypes: [],
        executionDurationMs: Date.now() - startedAt
      });

      if (isListRemindersShortcutRequest(trimmedText)) {
        return this.listPendingReminders(params.chatId, trimmedText);
      }

      const plannerFailureReply = this.buildPlannerFailureReply(plannerOutputRaw);
      await this.conversationService.recordTurn(
        params.chatId,
        params.userId,
        trimmedText,
        plannerFailureReply
      );
      return plannerFailureReply;
    }

    const execution = await this.executePlannedActions(params, trimmedText, plan);
    this.logPlannerTelemetry({
      stage: "planner_executed",
      chatId: params.chatId,
      userId: params.userId,
      rawUserInput: trimmedText,
      plannerOutput: plannerOutputRaw,
      validationErrors,
      normalizationErrors,
      executedActionTypes: execution.executedActionTypes,
      executionDurationMs: Date.now() - startedAt
    });

    if (execution.reply) {
      await this.conversationService.recordTurn(params.chatId, params.userId, trimmedText, execution.reply);
      return execution.reply;
    }

    const noActionReply =
      "I couldn't determine an actionable response from that message. Please rephrase and include more detail.";
    await this.conversationService.recordTurn(params.chatId, params.userId, trimmedText, noActionReply);
    return noActionReply;
  }

  private async routeTextMessageLegacy(
    params: {
      chatId: number;
      userId: number;
      text: string;
      quotedMessageText?: string;
    },
    trimmedText: string
  ): Promise<string> {
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

    let intent = await this.intentParser.extractReminderIntent(trimmedText, env.APP_TIMEZONE);
    intent = this.intentParser.applyWeeklyRecurrenceFromUserText(trimmedText, intent, env.APP_TIMEZONE);
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

      const recurrenceJson = intent.weeklyRecurrence
        ? serializeWeeklyRecurrence({
            kind: "weekly",
            weekdays: intent.weeklyRecurrence.weekdays,
            hour: intent.weeklyRecurrence.hour,
            minute: intent.weeklyRecurrence.minute
          })
        : null;

      const reminderId = await this.remindersRepo.createReminder({
        chatId: params.chatId,
        userId: params.userId,
        message: intent.reminderMessage,
        dueAtUtc: dueUtc.toISO() ?? new Date().toISOString(),
        timezone: env.APP_TIMEZONE,
        recurrenceJson
      });

      const localDue = dueUtc.setZone(env.APP_TIMEZONE).toFormat("dd/LL/yyyy HH:mm");
      const localDueWithEmoji = formatLocalDueWithEmoji(localDue);
      const recurringLabel = recurrenceJson ? formatWeeklyRecurrenceSummary(recurrenceJson) : null;
      if (recurringLabel) {
        return `✅ Recurring reminder #${reminderId}: ${intent.reminderMessage} (${recurringLabel}, next ${localDueWithEmoji})`;
      }
      return `✅ Reminder saved #${reminderId}: ${intent.reminderMessage} (${localDueWithEmoji})`;
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

  private async executePlannedActions(
    params: { chatId: number; userId: number; quotedMessageText?: string },
    rawUserInput: string,
    plan: MessageActionPlan
  ): Promise<{ reply: string | null; executedActionTypes: string[] }> {
    if (plan.needsClarification) {
      const clarificationQuestion =
        plan.clarificationQuestion?.trim() ||
        plan.actions.find((action) => action.type === "ask_clarification")?.question;
      if (clarificationQuestion) {
        return {
          reply: clarificationQuestion,
          executedActionTypes: ["ask_clarification"]
        };
      }
      return {
        reply: "I need one more detail before I proceed. Can you clarify your request?",
        executedActionTypes: ["ask_clarification"]
      };
    }

    const planFingerprint = fingerprintPlan(params.chatId, params.userId, rawUserInput, plan);
    if (this.wasPlanExecutedRecently(planFingerprint)) {
      return {
        reply: "I already processed that request recently, so I skipped duplicate execution.",
        executedActionTypes: ["idempotency_skip"]
      };
    }

    const replies: string[] = [];
    const executedActionTypes: string[] = [];
    const quotedRef = extractQuotedReference(params.quotedMessageText);

    for (const action of plan.actions) {
      const actionStartedAt = Date.now();
      const actionReply = await this.executeSinglePlannedAction(
        {
          chatId: params.chatId,
          userId: params.userId,
          quotedRef
        },
        action
      );
      executedActionTypes.push(action.type);
      if (actionReply) {
        replies.push(actionReply);
      }
      console.info("planner_action_duration_ms", {
        chatId: params.chatId,
        userId: params.userId,
        actionType: action.type,
        durationMs: Date.now() - actionStartedAt
      });
    }

    this.recordExecutedPlan(planFingerprint);
    return {
      reply: replies.length > 0 ? replies.join("\n") : null,
      executedActionTypes
    };
  }

  private async executeSinglePlannedAction(
    params: { chatId: number; userId: number; quotedRef: QuotedReference | null },
    action: PlannedAction
  ): Promise<string | null> {
    switch (action.type) {
      case "create_reminder":
        return this.createReminderFromPlannedAction(params.chatId, params.userId, action);
      case "create_task":
        return this.createTaskFromPlannedAction(params.chatId, params.userId, action.task);
      case "answer_user":
        return action.text.trim();
      case "list_reminders":
        return this.listPendingReminders(params.chatId, action.filter ?? undefined);
      case "list_tasks":
        return this.listPendingTasks(params.chatId);
      case "delete_reminder":
        return this.deleteReminders(
          params.chatId,
          mapPlannedDeleteReminderActionToRequest(action),
          params.quotedRef
        );
      case "delete_task":
        return this.deleteTasks(params.chatId, mapPlannedDeleteTaskActionToRequest(action), params.quotedRef);
      case "adjust_reminder": {
        const targetReminderId = await this.resolveTargetReminderId(
          params.chatId,
          action.id ?? undefined,
          params.quotedRef
        );
        if (!targetReminderId) {
          return (
            "I couldn't determine which reminder to adjust. " +
            "Reply to a reminder message or provide a reminder ID."
          );
        }
        return this.adjustReminderByInstruction(params.chatId, targetReminderId, action.instructions);
      }
      case "ask_clarification":
        return action.question.trim();
      default:
        return null;
    }
  }

  private async createReminderFromPlannedAction(
    chatId: number,
    userId: number,
    action: Extract<PlannedAction, { type: "create_reminder" }>
  ): Promise<string> {
    const dueUtc = DateTime.fromISO(action.dueAtIso).toUTC();
    if (!dueUtc.isValid) {
      return "⚠️ I couldn't parse one planned reminder time.";
    }

    const recurrenceJson = action.recurrence
      ? serializeWeeklyRecurrence({
          kind: "weekly",
          weekdays: action.recurrence.weekdays,
          hour: action.recurrence.hour,
          minute: action.recurrence.minute
        })
      : null;

    const dueAtUtc = dueUtc.toISO() ?? new Date().toISOString();
    const existing = await this.remindersRepo.getExistingPendingReminder({
      chatId,
      message: action.message,
      dueAtUtc,
      recurrenceJson
    });
    if (existing) {
      const existingDue = DateTime.fromISO(existing.dueAtUtc, { zone: "utc" })
        .setZone(env.APP_TIMEZONE)
        .toFormat("dd/LL/yyyy HH:mm");
      return `ℹ️ Reminder already exists #${existing.id}: ${existing.message} (${formatLocalDueWithEmoji(existingDue)})`;
    }

    const reminderId = await this.remindersRepo.createReminder({
      chatId,
      userId,
      message: action.message,
      dueAtUtc,
      timezone: env.APP_TIMEZONE,
      recurrenceJson
    });
    const localDue = dueUtc.setZone(env.APP_TIMEZONE).toFormat("dd/LL/yyyy HH:mm");
    const localDueWithEmoji = formatLocalDueWithEmoji(localDue);
    const recurringLabel = recurrenceJson ? formatWeeklyRecurrenceSummary(recurrenceJson) : null;
    if (recurringLabel) {
      return `✅ Recurring reminder #${reminderId}: ${action.message} (${recurringLabel}, next ${localDueWithEmoji})`;
    }
    return `✅ Reminder saved #${reminderId}: ${action.message} (${localDueWithEmoji})`;
  }

  private async createTaskFromPlannedAction(
    chatId: number,
    userId: number,
    task: string
  ): Promise<string> {
    const normalizedTask = task.trim();
    if (!normalizedTask) {
      return "⚠️ I couldn't save an empty planned task.";
    }

    const existing = await this.tasksRepo.getExistingPendingTask(chatId, normalizedTask);
    if (existing) {
      return `ℹ️ Task already exists #${existing.id}: ${existing.task}`;
    }

    const id = await this.tasksRepo.createTask({ chatId, userId, task: normalizedTask });
    return `✅ Task added #${id}: ${normalizedTask}`;
  }

  private logPlannerTelemetry(payload: {
    stage: "planner_invalid" | "planner_executed";
    chatId: number;
    userId: number;
    rawUserInput: string;
    plannerOutput: string | null;
    validationErrors: string[];
    normalizationErrors: string[];
    executedActionTypes: string[];
    executionDurationMs: number;
  }): void {
    console.info("planner_message_log", {
      stage: payload.stage,
      chatId: payload.chatId,
      userId: payload.userId,
      rawUserInput: payload.rawUserInput,
      plannerOutput: payload.plannerOutput,
      validationErrors: payload.validationErrors,
      normalizationErrors: payload.normalizationErrors,
      executedActionsCount: payload.executedActionTypes.length,
      executedActionTypes: payload.executedActionTypes,
      executionDurationMs: payload.executionDurationMs
    });
  }

  private buildPlannerFailureReply(plannerOutputRaw: string | null): string {
    if (plannerOutputRaw) {
      try {
        const parsed = JSON.parse(plannerOutputRaw) as {
          clarificationQuestion?: unknown;
          actions?: unknown;
        };
        if (
          typeof parsed.clarificationQuestion === "string" &&
          parsed.clarificationQuestion.trim().length > 0
        ) {
          return parsed.clarificationQuestion.trim();
        }
        if (Array.isArray(parsed.actions)) {
          for (const action of parsed.actions) {
            if (!action || typeof action !== "object") {
              continue;
            }
            const candidate = action as { type?: unknown; question?: unknown };
            if (
              candidate.type === "ask_clarification" &&
              typeof candidate.question === "string" &&
              candidate.question.trim().length > 0
            ) {
              return candidate.question.trim();
            }
          }
        }
      } catch {
        // Ignore parse errors and use generic fallback text below.
      }
    }

    return "I couldn't understand that request. Please rephrase it with a bit more detail.";
  }

  private wasPlanExecutedRecently(planFingerprint: string): boolean {
    this.prunePlanFingerprintCache();
    const existingTimestamp = MessageRouter.recentPlanFingerprints.get(planFingerprint);
    return typeof existingTimestamp === "number";
  }

  private recordExecutedPlan(planFingerprint: string): void {
    this.prunePlanFingerprintCache();
    MessageRouter.recentPlanFingerprints.set(planFingerprint, Date.now());
  }

  private prunePlanFingerprintCache(): void {
    const cutoff = Date.now() - MessageRouter.PLAN_DEDUP_TTL_MS;
    for (const [key, timestamp] of MessageRouter.recentPlanFingerprints.entries()) {
      if (timestamp < cutoff) {
        MessageRouter.recentPlanFingerprints.delete(key);
      }
    }
  }

  private rememberListContext(chatId: number, targetType: DeleteTargetType, ids: number[]): void {
    const payload = { ids, createdAt: Date.now() };
    if (targetType === "reminder") {
      MessageRouter.recentReminderListByChat.set(chatId, payload);
      return;
    }
    MessageRouter.recentTaskListByChat.set(chatId, payload);
  }

  private resolveListPosition(
    chatId: number,
    targetType: DeleteTargetType,
    listPosition: number
  ): number | null {
    if (!Number.isFinite(listPosition) || listPosition <= 0) {
      return null;
    }
    const ctx =
      targetType === "reminder"
        ? MessageRouter.recentReminderListByChat.get(chatId)
        : MessageRouter.recentTaskListByChat.get(chatId);
    if (!ctx) {
      return null;
    }
    if (Date.now() - ctx.createdAt > MessageRouter.LIST_CONTEXT_TTL_MS) {
      if (targetType === "reminder") {
        MessageRouter.recentReminderListByChat.delete(chatId);
      } else {
        MessageRouter.recentTaskListByChat.delete(chatId);
      }
      return null;
    }
    return ctx.ids[listPosition - 1] ?? null;
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

    const created: Array<{ id: number; message: string; localDue: string; recurringLabel: string | null }> =
      [];

    for (const intent of validIntents) {
      const dueUtc = DateTime.fromISO(intent.dueAtIso as string).toUTC();
      if (!dueUtc.isValid) {
        continue;
      }

      const recurrenceJson = intent.weeklyRecurrence
        ? serializeWeeklyRecurrence({
            kind: "weekly",
            weekdays: intent.weeklyRecurrence.weekdays,
            hour: intent.weeklyRecurrence.hour,
            minute: intent.weeklyRecurrence.minute
          })
        : null;

      const reminderId = await this.remindersRepo.createReminder({
        chatId,
        userId,
        message: intent.reminderMessage as string,
        dueAtUtc: dueUtc.toISO() ?? new Date().toISOString(),
        timezone: env.APP_TIMEZONE,
        recurrenceJson
      });
      const localDue = dueUtc.setZone(env.APP_TIMEZONE).toFormat("dd/LL/yyyy HH:mm");
      created.push({
        id: reminderId,
        message: intent.reminderMessage as string,
        localDue: formatLocalDueWithEmoji(localDue),
        recurringLabel: recurrenceJson ? formatWeeklyRecurrenceSummary(recurrenceJson) : null
      });
    }

    if (created.length === 0) {
      return null;
    }

    if (created.length === 1) {
      const one = created[0];
      if (one.recurringLabel) {
        return `✅ Recurring reminder #${one.id}: ${one.message} (${one.recurringLabel}, next ${one.localDue})`;
      }
      return `✅ Reminder saved #${one.id}: ${one.message} (${one.localDue})`;
    }

    const lines = created.map((item) => {
      const suffix = item.recurringLabel ? ` 🔁 ${item.recurringLabel}` : "";
      return `• #${item.id}: ${item.message} (${item.localDue})${suffix}`;
    });
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
    this.rememberListContext(chatId, "reminder", filteredReminders.map((item) => item.id));

    const lines = filteredReminders.map((reminder, index) => {
      const dueLocal = DateTime.fromISO(reminder.dueAtUtc, { zone: "utc" })
        .setZone(env.APP_TIMEZONE)
        .toFormat("dd/LL/yyyy HH:mm");
      const recurring = formatWeeklyRecurrenceSummary(reminder.recurrenceJson);
      return [`${index + 1}. ${reminder.message}`, `${formatLocalDueWithEmoji(dueLocal)}`, recurring ? `🔁 ${recurring}` : null, "--------------------"]
        .filter(Boolean)
        .join("\n");
    });

    return [`📌 Pending reminders (${filteredReminders.length})`, "", ...lines].join("\n");
  }

  private async listPendingTasks(chatId: number): Promise<string> {
    const tasks = await this.tasksRepo.getPendingTasksByChat(chatId, 50);
    if (tasks.length === 0) {
      return "You have no pending tasks.";
    }
    this.rememberListContext(chatId, "task", tasks.map((item) => item.id));

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
            const recurring = formatWeeklyRecurrenceSummary(reminder.recurrenceJson);
            const suffix = recurring ? ` 🔁 ${recurring}` : "";
            return `• #${reminder.id}: ${reminder.message} (${formatLocalDueWithEmoji(dueLocal)})${suffix}`;
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

    if (request.mode === "single" && request.listPosition) {
      const resolvedByPosition = this.resolveListPosition(chatId, "reminder", request.listPosition);
      if (resolvedByPosition) {
        targetIds = [resolvedByPosition];
      }
    } else if (request.mode === "single" && request.ids.length === 1) {
      if (pendingById.has(request.ids[0])) {
        targetIds = [request.ids[0]];
      } else {
        const resolvedByPosition = this.resolveListPosition(chatId, "reminder", request.ids[0]);
        if (resolvedByPosition) {
          targetIds = [resolvedByPosition];
        }
      }
    } else if (request.mode === "count" && request.count) {
      targetIds = pendingReminders.slice(0, request.count).map((item) => item.id);
    } else if (request.mode === "ids" && request.ids.length > 0) {
      targetIds = request.ids;
    } else if (request.mode === "single" && request.queryText) {
      const query = request.queryText.toLowerCase().trim();
      const exact = pendingReminders.filter((item) => item.message.toLowerCase().trim() === query);
      if (exact.length === 1) {
        targetIds = [exact[0].id];
      } else {
        const partial = pendingReminders.filter((item) => item.message.toLowerCase().includes(query));
        if (partial.length === 1) {
          targetIds = [partial[0].id];
        } else if (partial.length > 1) {
          const options = partial.slice(0, 5).map((item) => `#${item.id}: ${item.message}`).join("\n");
          return [
            `I found ${partial.length} reminders matching "${request.queryText}".`,
            "Please delete by replying to the target reminder or include an ID.",
            options
          ].join("\n");
        }
      }
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

    if (request.mode === "single" && request.listPosition) {
      const resolvedByPosition = this.resolveListPosition(chatId, "task", request.listPosition);
      if (resolvedByPosition) {
        targetIds = [resolvedByPosition];
      }
    } else if (request.mode === "single" && request.ids.length === 1) {
      if (pendingById.has(request.ids[0])) {
        targetIds = [request.ids[0]];
      } else {
        const resolvedByPosition = this.resolveListPosition(chatId, "task", request.ids[0]);
        if (resolvedByPosition) {
          targetIds = [resolvedByPosition];
        }
      }
    } else if (request.mode === "count" && request.count) {
      targetIds = pendingTasks.slice(0, request.count).map((item) => item.id);
    } else if (request.mode === "ids" && request.ids.length > 0) {
      targetIds = request.ids;
    } else if (request.mode === "single" && request.queryText) {
      const query = request.queryText.toLowerCase().trim();
      const exact = pendingTasks.filter((item) => item.task.toLowerCase().trim() === query);
      if (exact.length === 1) {
        targetIds = [exact[0].id];
      } else {
        const partial = pendingTasks.filter((item) => item.task.toLowerCase().includes(query));
        if (partial.length === 1) {
          targetIds = [partial[0].id];
        } else if (partial.length > 1) {
          const options = partial.slice(0, 5).map((item) => `#${item.id}: ${item.task}`).join("\n");
          return [
            `I found ${partial.length} tasks matching "${request.queryText}".`,
            "Please delete by replying to the target task or include an ID.",
            options
          ].join("\n");
        }
      }
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
    reminders: ReminderRecord[],
    userMessage?: string
  ): Promise<ReminderRecord[]> {
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
  queryText?: string;
  listPosition?: number;
}

function mapPlannedDeleteReminderActionToRequest(action: PlannedDeleteReminderAction): DeleteRequest {
  return {
    targetType: "reminder",
    mode: action.mode,
    ids: action.ids ?? [],
    count: action.count,
    queryText: action.queryText?.trim() || undefined,
    listPosition: action.listPosition ?? undefined
  };
}

function mapPlannedDeleteTaskActionToRequest(action: PlannedDeleteTaskAction): DeleteRequest {
  return {
    targetType: "task",
    mode: action.mode,
    ids: action.ids ?? [],
    count: action.count,
    queryText: action.queryText?.trim() || undefined,
    listPosition: action.listPosition ?? undefined
  };
}

function fingerprintPlan(
  chatId: number,
  userId: number,
  rawUserInput: string,
  plan: MessageActionPlan
): string {
  const normalizedPayload = JSON.stringify({
    chatId,
    userId,
    rawUserInput: rawUserInput.trim(),
    plan
  });
  return createHash("sha256").update(normalizedPayload).digest("hex");
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

function isListRemindersShortcutRequest(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  return /^(reminder|reminders|remind|reminds|remider|remiders)$/.test(normalized);
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
  const raw = text.trim();
  const normalized = raw.toLowerCase();
  if (!/\b(delete|remove|cancel)\b/i.test(raw)) {
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
    /\b(delete|remove|cancel)\s+(\d+)\s+(?:my\s+)?(?:reminders|tasks|todos|to-dos)\b/i
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
    return { targetType, mode: "single", ids: [], listPosition: uniqueIds[0] };
  }

  const queryText = extractDeleteQueryText(raw, targetType);
  if (queryText) {
    return { targetType, mode: "single", ids: [], queryText };
  }

  return { targetType, mode: "single", ids: [] };
}

function extractDeleteQueryText(rawText: string, targetType: DeleteTargetType): string | undefined {
  const nounPattern = targetType === "reminder" ? "(?:reminder|reminders)" : "(?:task|tasks|todo|to-do)";
  const patterns = [
    new RegExp(`\\b(?:delete|remove|cancel)\\s+(?:my\\s+)?${nounPattern}\\s*(?:#\\d+)?\\s*(?:named\\s+|called\\s+|:)?\\s*(.+)$`, "i"),
    new RegExp(`\\b(?:delete|remove|cancel)\\s+(.+?)\\s+${nounPattern}\\b$`, "i"),
    new RegExp(`\\b(?:delete|remove|cancel)\\s+(.+)$`, "i")
  ];

  for (const pattern of patterns) {
    const match = rawText.match(pattern);
    const candidate = match?.[1]?.trim();
    if (!candidate) {
      continue;
    }

    const cleaned = candidate.replace(/^["'`]+|["'`]+$/g, "").trim();
    if (!cleaned) {
      continue;
    }
    if (/^(this|that|it|one|ones)$/i.test(cleaned)) {
      continue;
    }
    return cleaned;
  }

  return undefined;
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

function formatLocalDueWithEmoji(localDue: string): string {
  const [datePart, timePart] = localDue.split(" ");
  if (!datePart || !timePart) {
    return `📅 ${localDue}`;
  }
  return `📅 ${datePart} ⏰ ${timePart}`;
}
