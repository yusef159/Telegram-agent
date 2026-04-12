export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  createdAt: string;
}

export interface SessionRecord {
  chatId: number;
  messages: ChatMessage[];
  updatedAt: string;
}

export type ReminderStatus = "pending" | "sent" | "failed" | "cancelled";

export interface ReminderRecord {
  id: number;
  chatId: number;
  userId: number;
  message: string;
  dueAtUtc: string;
  timezone: string;
  status: ReminderStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ParsedReminderIntent {
  isReminder: boolean;
  reminderMessage: string | null;
  dueAtIso: string | null;
  confidence: number;
  reason?: string;
}

export type TaskStatus = "pending" | "completed" | "cancelled";

export interface TaskRecord {
  id: number;
  chatId: number;
  userId: number;
  task: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface UserMemoryFact {
  id: number;
  chatId: number;
  userId: number;
  factKey: string;
  factText: string;
  score: number;
  createdAt: string;
  updatedAt: string;
}
