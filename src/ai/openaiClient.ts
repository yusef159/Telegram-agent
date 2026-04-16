import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { z } from "zod";

import { env } from "../config/env";
import type {
  ChatMessage,
  MessageActionPlan,
  MessageActionPlanParseResult,
  ParsedReminderIntent,
  ReminderRecord,
  TaskRecord
} from "../types/domain";

const reminderSchema = z.object({
  isReminder: z.boolean().optional().default(false),
  reminderMessage: z.string().nullable().optional().default(null),
  dueAtIso: z.string().nullable().optional().default(null),
  confidence: z.number().min(0).max(1).optional().default(0.5),
  reason: z.string().nullable().optional()
});

const multiReminderSchema = z.object({
  reminders: z
    .array(
      z.object({
        reminderMessage: z.string().nullable().optional().default(null),
        dueAtIso: z.string().nullable().optional().default(null),
        confidence: z.number().min(0).max(1).optional().default(0.5),
        reason: z.string().nullable().optional()
      })
    )
    .optional()
    .default([])
});

const multiTaskSchema = z.object({
  tasks: z
    .array(
      z.object({
        task: z.string().nullable().optional().default(null),
        confidence: z.number().min(0).max(1).optional().default(0.5),
        reason: z.string().nullable().optional()
      })
    )
    .optional()
    .default([])
});

const extractedMemorySchema = z.object({
  facts: z.array(z.string()).optional().default([])
});

const reminderListFilterSchema = z.object({
  show: z.boolean().optional().default(true),
  dateMode: z.enum(["all", "today", "tomorrow", "specific_date"]).optional().default("all"),
  specificDate: z.string().nullable().optional(),
  keyword: z.string().nullable().optional()
});

const PLANNER_MAX_ACTIONS = 10;

const plannedWeeklyRecurrenceSchema = z
  .object({
    kind: z.literal("weekly"),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59)
  })
  .strict();

const plannedCreateReminderActionSchema = z
  .object({
    type: z.literal("create_reminder"),
    message: z.string().min(1),
    dueAtIso: z.string().min(1),
    recurrence: plannedWeeklyRecurrenceSchema.nullable().optional()
  })
  .strict();

const plannedCreateTaskActionSchema = z
  .object({
    type: z.literal("create_task"),
    task: z.string().min(1)
  })
  .strict();

const plannedAnswerUserActionSchema = z
  .object({
    type: z.literal("answer_user"),
    text: z.string().min(1)
  })
  .strict();

const plannedListRemindersActionSchema = z
  .object({
    type: z.literal("list_reminders"),
    filter: z.string().nullable().optional()
  })
  .strict();

const plannedListTasksActionSchema = z
  .object({
    type: z.literal("list_tasks")
  })
  .strict();

const plannedDeleteReminderActionSchema = z
  .object({
    type: z.literal("delete_reminder"),
    mode: z.enum(["single", "ids", "count", "all"]),
    ids: z.array(z.number().int().positive()).optional(),
    count: z.number().int().positive().optional(),
    queryText: z.string().nullable().optional(),
    listPosition: z.number().int().positive().nullable().optional()
  })
  .strict();

const plannedDeleteTaskActionSchema = z
  .object({
    type: z.literal("delete_task"),
    mode: z.enum(["single", "ids", "count", "all"]),
    ids: z.array(z.number().int().positive()).optional(),
    count: z.number().int().positive().optional(),
    queryText: z.string().nullable().optional(),
    listPosition: z.number().int().positive().nullable().optional()
  })
  .strict();

const plannedAdjustReminderActionSchema = z
  .object({
    type: z.literal("adjust_reminder"),
    id: z.number().int().positive().nullable().optional(),
    instructions: z.string().min(1)
  })
  .strict();

const plannedAskClarificationActionSchema = z
  .object({
    type: z.literal("ask_clarification"),
    question: z.string().min(1)
  })
  .strict();

const plannedActionSchema = z.discriminatedUnion("type", [
  plannedCreateReminderActionSchema,
  plannedCreateTaskActionSchema,
  plannedAnswerUserActionSchema,
  plannedListRemindersActionSchema,
  plannedListTasksActionSchema,
  plannedDeleteReminderActionSchema,
  plannedDeleteTaskActionSchema,
  plannedAdjustReminderActionSchema,
  plannedAskClarificationActionSchema
]);

const messageActionPlanSchema = z
  .object({
    version: z.string().default("1.0"),
    actions: z.array(plannedActionSchema).max(PLANNER_MAX_ACTIONS),
    needsClarification: z.boolean().optional().default(false),
    clarificationQuestion: z.string().nullable().optional()
  })
  .strict();

export class OpenAiClient {
  private readonly client: OpenAI;

  constructor() {
    this.client = new OpenAI({ apiKey: env.AI_API_KEY });
  }

  async generateAssistantReply(params: {
    userMessage: string;
    history: ChatMessage[];
    memoryFacts?: string[];
  }): Promise<string> {
    const memorySection =
      params.memoryFacts && params.memoryFacts.length > 0
        ? `Known user profile facts:\n- ${params.memoryFacts.join("\n- ")}`
        : "Known user profile facts: none";

    const completion = await this.runWithTimeout(() =>
      this.client.chat.completions.create({
        model: env.OPENAI_MODEL,
        temperature: 0.7,
        messages: [
          {
            role: "system",
            content: [
              "You are a concise, warm, and helpful Telegram assistant.",
              "This bot can set reminders for users.",
              "Use known user profile facts when relevant.",
              "Keep responses brief, practical, and friendly.",
              "Use simple, positive wording and a supportive tone.",
              memorySection
            ].join("\n")
          },
          ...params.history.map((message) => ({
            role: message.role,
            content: message.content
          })),
          {
            role: "user",
            content: params.userMessage
          }
        ]
      })
    );

    return (
      completion.choices[0]?.message?.content?.trim() ||
      "I couldn't produce a response right now. Please try again."
    );
  }

  async extractPersonalMemoryFacts(params: {
    userMessage: string;
    existingFacts: string[];
  }): Promise<string[]> {
    const completion = await this.runWithTimeout(() =>
      this.client.chat.completions.create({
        model: env.OPENAI_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "Decide whether to save long-term memory from this message.",
              "Extract only durable personal user facts useful for future personalization.",
              "Examples: preferences, routine, role, goals, constraints, tone preferences.",
              "Do NOT extract temporary chat content.",
              "If the message should not be stored, return an empty facts array.",
              "If user explicitly asks to remember/save a personal preference or profile detail, include it.",
              "Return JSON only: { facts: string[] }",
              "Max 2 facts, each under 90 characters."
            ].join(" ")
          },
          {
            role: "user",
            content: [
              `Current memory facts: ${JSON.stringify(params.existingFacts)}`,
              `New user message: ${params.userMessage}`
            ].join("\n")
          }
        ]
      })
    );

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      return [];
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      return [];
    }

    const parsed = extractedMemorySchema.safeParse(parsedJson);
    if (!parsed.success) {
      return [];
    }

    return parsed.data.facts
      .map((fact) => fact.trim())
      .filter(Boolean)
      .slice(0, 2);
  }

  async parseReminderIntent(params: {
    userMessage: string;
    nowIsoInTimezone: string;
    timezone: string;
  }): Promise<ParsedReminderIntent> {
    const completion = await this.runWithTimeout(() =>
      this.client.chat.completions.create({
        model: env.OPENAI_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You extract reminder intent from user text.",
              "Return only JSON with keys:",
              "isReminder (boolean), reminderMessage (string|null), dueAtIso (string|null), confidence (0..1), reason (optional string|null).",
              `Timezone is always ${params.timezone}.`,
              `Current time in timezone: ${params.nowIsoInTimezone}.`,
              "If user is not asking to set a reminder, set isReminder=false.",
              "For reminder requests, dueAtIso must be ISO-8601 with timezone offset.",
              "If time is unclear, set isReminder=true, dueAtIso=null and include reason.",
              "Phrases like every/weekly plus weekdays still count as a reminder request (isReminder=true)."
            ].join(" ")
          },
          {
            role: "user",
            content: params.userMessage
          }
        ]
      })
    );

    const content = completion.choices[0]?.message?.content;

    if (!content) {
      throw new Error("OpenAI returned empty reminder parsing response.");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      return {
        isReminder: false,
        reminderMessage: null,
        dueAtIso: null,
        confidence: 0,
        reason: "AI returned invalid JSON for reminder parsing."
      };
    }

    const normalized = reminderSchema.safeParse(parsedJson);

    if (!normalized.success) {
      return {
        isReminder: false,
        reminderMessage: null,
        dueAtIso: null,
        confidence: 0,
        reason: "AI returned malformed reminder fields."
      };
    }

    return {
      ...normalized.data,
      reason: normalized.data.reason ?? undefined
    };
  }

  async parseMultipleReminderIntents(params: {
    userMessage: string;
    nowIsoInTimezone: string;
    timezone: string;
  }): Promise<ParsedReminderIntent[]> {
    const completion = await this.runWithTimeout(() =>
      this.client.chat.completions.create({
        model: env.OPENAI_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You extract ALL reminder requests from user text.",
              "Return only JSON with this shape:",
              "{ reminders: [{ reminderMessage, dueAtIso, confidence, reason }] }",
              `Timezone is always ${params.timezone}.`,
              `Current time in timezone: ${params.nowIsoInTimezone}.`,
              "If no reminders exist, return reminders as an empty array.",
              "dueAtIso must be ISO-8601 with timezone offset when available.",
              "If user asks for several reminders in one message, return one item per reminder.",
              "If user asks for the same reminder on multiple weekdays/dates, return one item per weekday/date mention.",
              "If weekday reminders do not include an explicit time, use 09:00 in the given timezone.",
              "If user asks for a WEEKLY REPEATING reminder (every/weekly + weekday(s)), return ONE item with dueAtIso set to the next occurrence and the full task text; do not split into separate one-off reminders for that case."
            ].join(" ")
          },
          { role: "user", content: params.userMessage }
        ]
      })
    );

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      return [];
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      return [];
    }

    const normalized = multiReminderSchema.safeParse(parsedJson);
    if (!normalized.success) {
      return [];
    }

    return normalized.data.reminders.map((item) => ({
      isReminder: true,
      reminderMessage: item.reminderMessage ?? null,
      dueAtIso: item.dueAtIso ?? null,
      confidence: item.confidence ?? 0.5,
      reason: item.reason ?? undefined
    }));
  }

  async parseMultipleTaskItems(params: { userMessage: string }): Promise<string[]> {
    const completion = await this.runWithTimeout(() =>
      this.client.chat.completions.create({
        model: env.OPENAI_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You extract TODO tasks from user text.",
              "Return only JSON in this shape:",
              "{ tasks: [{ task, confidence, reason }] }",
              "Extract one or more actionable tasks the user wants to add.",
              "If user is not asking to add tasks, return tasks as an empty array."
            ].join(" ")
          },
          { role: "user", content: params.userMessage }
        ]
      })
    );

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      return [];
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      return [];
    }

    const normalized = multiTaskSchema.safeParse(parsedJson);
    if (!normalized.success) {
      return [];
    }

    return normalized.data.tasks
      .filter((item) => (item.confidence ?? 0.5) >= 0.4 && item.task)
      .map((item) => (item.task ?? "").trim())
      .filter(Boolean);
  }

  async transcribeVoiceNote(audioBuffer: Buffer): Promise<string> {
    const audioFile = await toFile(audioBuffer, "voice-note.ogg");
    const transcription = await this.runWithTimeout(() =>
      this.client.audio.transcriptions.create({
        file: audioFile,
        model: "whisper-1"
      })
    );

    return transcription.text?.trim() ?? "";
  }

  async generateImageReply(params: {
    prompt: string;
    imageBuffer: Buffer;
    mimeType?: string;
  }): Promise<string> {
    const mimeType = params.mimeType?.startsWith("image/") ? params.mimeType : "image/jpeg";
    const base64Image = params.imageBuffer.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64Image}`;

    const completion = await this.runWithTimeout(() =>
      this.client.chat.completions.create({
        model: env.OPENAI_MODEL,
        temperature: 0.4,
        messages: [
          {
            role: "system",
            content:
              "You are a concise and helpful Telegram assistant. Analyze user images and respond clearly."
          },
          {
            role: "user",
            content: [
              { type: "text", text: params.prompt },
              { type: "image_url", image_url: { url: dataUrl } }
            ]
          }
        ]
      })
    );

    return (
      completion.choices[0]?.message?.content?.trim() ||
      "I could not analyze that image right now. Please try another one."
    );
  }

  async answerQuestionWithData(params: {
    question: string;
    reminders: ReminderRecord[];
    tasks: TaskRecord[];
  }): Promise<string> {
    const normalizedReminders = params.reminders.map((item) => ({
      id: item.id,
      message: item.message,
      dueAtUtc: item.dueAtUtc,
      status: item.status,
      recurringWeekly: Boolean(item.recurrenceJson?.trim())
    }));

    const normalizedTasks = params.tasks.map((item) => ({
      id: item.id,
      task: item.task,
      status: item.status
    }));

    const completion = await this.runWithTimeout(() =>
      this.client.chat.completions.create({
        model: env.OPENAI_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: [
              "You answer user questions using ONLY the provided reminders/tasks data.",
              "Do not invent entries that are not in the data.",
              "If answer is not present, clearly say it is not found.",
              "Be concise and practical.",
              "Do not use emojis unless explicitly requested."
            ].join(" ")
          },
          {
            role: "user",
            content: [
              `Question: ${params.question}`,
              `RemindersData: ${JSON.stringify(normalizedReminders)}`,
              `TasksData: ${JSON.stringify(normalizedTasks)}`
            ].join("\n")
          }
        ]
      })
    );

    return (
      completion.choices[0]?.message?.content?.trim() ||
      "I couldn't determine that from your reminders/tasks right now."
    );
  }

  async parseReminderListFilter(params: {
    userMessage: string;
    nowIsoInTimezone: string;
    timezone: string;
  }): Promise<{
    show: boolean;
    dateMode: "all" | "today" | "tomorrow" | "specific_date";
    specificDate?: string;
    keyword?: string;
  }> {
    const completion = await this.runWithTimeout(() =>
      this.client.chat.completions.create({
        model: env.OPENAI_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "Extract reminder-list filtering intent from user message.",
              "Return JSON only with keys: show, dateMode, specificDate, keyword.",
              "dateMode must be one of: all, today, tomorrow, specific_date.",
              "Use specificDate only when dateMode is specific_date, format YYYY-MM-DD.",
              "keyword is optional and should be short.",
              `Timezone: ${params.timezone}.`,
              `Current date-time in timezone: ${params.nowIsoInTimezone}.`
            ].join(" ")
          },
          { role: "user", content: params.userMessage }
        ]
      })
    );

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      return { show: true, dateMode: "all" };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      return { show: true, dateMode: "all" };
    }

    const parsed = reminderListFilterSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return { show: true, dateMode: "all" };
    }

    const keyword = parsed.data.keyword?.trim() || undefined;
    const specificDate = parsed.data.specificDate?.trim() || undefined;

    return {
      show: parsed.data.show,
      dateMode: parsed.data.dateMode,
      specificDate,
      keyword
    };
  }

  async planMessageActions(params: {
    userMessage: string;
    nowIsoInTimezone: string;
    timezone: string;
  }): Promise<MessageActionPlanParseResult> {
    const completion = await this.runWithTimeout(() =>
      this.client.chat.completions.create({
        model: env.OPENAI_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "Convert the user message into an executable JSON plan.",
              "Return JSON only with keys: version, actions, needsClarification, clarificationQuestion.",
              `actions count must be <= ${PLANNER_MAX_ACTIONS}.`,
              "Action key must be 'type'.",
              "Allowed types: create_reminder, create_task, answer_user, list_reminders, list_tasks, delete_reminder, delete_task, adjust_reminder, ask_clarification.",
              "Chat/general questions => one answer_user action.",
              "create_reminder needs message + dueAtIso (ISO with offset); weekly recurrence: {kind:'weekly', weekdays:[1..7], hour, minute}.",
              "delete_* uses mode single|ids|count|all; use queryText for text match, listPosition for numbered list.",
              "If ambiguous, set needsClarification=true and include ask_clarification.",
              `Timezone: ${params.timezone}.`,
              `Current time in timezone: ${params.nowIsoInTimezone}.`
            ].join(" ")
          },
          {
            role: "user",
            content: params.userMessage
          }
        ]
      })
    );

    const rawOutput = completion.choices[0]?.message?.content?.trim() ?? null;
    if (!rawOutput) {
      return {
        rawOutput: null,
        plan: null,
        validationErrors: ["Planner returned empty response."]
      };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawOutput);
    } catch {
      return {
        rawOutput,
        plan: null,
        validationErrors: ["Planner returned non-JSON output."]
      };
    }

    const normalizedParsedJson = normalizePlannerPayload(parsedJson);
    const parsed = messageActionPlanSchema.safeParse(normalizedParsedJson);
    if (!parsed.success) {
      return {
        rawOutput,
        plan: null,
        validationErrors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      };
    }

    return {
      rawOutput,
      plan: parsed.data as MessageActionPlan,
      validationErrors: []
    };
  }

  private async runWithTimeout<T>(operation: () => Promise<T>): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("OpenAI request timed out.")), env.OPENAI_TIMEOUT_MS);
    });

    return Promise.race([operation(), timeoutPromise]);
  }
}

function normalizePlannerPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  const root = payload as Record<string, unknown>;
  if (!Array.isArray(root.actions)) {
    return payload;
  }

  const normalizedActions = root.actions.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }

    const rawAction = entry as Record<string, unknown>;
    const normalizedAction: Record<string, unknown> = { ...rawAction };

    if (
      typeof normalizedAction.type !== "string" &&
      typeof normalizedAction.action === "string"
    ) {
      normalizedAction.type = normalizedAction.action;
    }

    if (
      normalizedAction.type === "answer_user" &&
      typeof normalizedAction.text !== "string" &&
      typeof normalizedAction.message === "string"
    ) {
      normalizedAction.text = normalizedAction.message;
    }

    if (
      normalizedAction.type === "ask_clarification" &&
      typeof normalizedAction.question !== "string"
    ) {
      if (typeof normalizedAction.text === "string") {
        normalizedAction.question = normalizedAction.text;
      } else if (typeof normalizedAction.message === "string") {
        normalizedAction.question = normalizedAction.message;
      }
    }

    // Planner legacy alias: ensure strict schema compatibility.
    delete normalizedAction.action;
    if (
      normalizedAction.type === "answer_user" ||
      normalizedAction.type === "ask_clarification"
    ) {
      delete normalizedAction.message;
    }
    return normalizedAction;
  });

  return {
    ...root,
    actions: normalizedActions
  };
}
