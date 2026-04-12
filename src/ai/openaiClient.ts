import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { z } from "zod";

import { env } from "../config/env";
import type { ChatMessage, ParsedReminderIntent, ReminderRecord, TaskRecord } from "../types/domain";

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
              "You are a concise and helpful Telegram assistant.",
              "This bot can set reminders for users.",
              "Use known user profile facts when relevant.",
              "Keep responses brief and practical.",
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
              "If time is unclear, set isReminder=true, dueAtIso=null and include reason."
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
              "dueAtIso must be ISO-8601 with timezone offset when available."
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
      status: item.status
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

  private async runWithTimeout<T>(operation: () => Promise<T>): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("OpenAI request timed out.")), env.OPENAI_TIMEOUT_MS);
    });

    return Promise.race([operation(), timeoutPromise]);
  }
}
