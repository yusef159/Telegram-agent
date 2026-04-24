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
  /** JSON payload when this row is a repeating schedule (e.g. weekly on selected weekdays). */
  recurrenceJson: string | null;
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
  /** When set, after each fire the scheduler reschedules to the next matching weekday. */
  weeklyRecurrence?: { weekdays: number[]; hour: number; minute: number } | null;
}

export interface PlannedWeeklyRecurrence {
  kind: "weekly";
  weekdays: number[];
  hour: number;
  minute: number;
}

export interface PlannedCreateReminderAction {
  type: "create_reminder";
  message: string;
  dueAtIso: string;
  recurrence?: PlannedWeeklyRecurrence | null;
}

export interface PlannedCreateTaskAction {
  type: "create_task";
  task: string;
}

export interface PlannedAnswerUserAction {
  type: "answer_user";
  text: string;
}

export interface PlannedFetchNewsAction {
  type: "fetch_news";
  category?: string | null;
  maxItems?: number | null;
}

export interface PlannedSetNewsSubscriptionAction {
  type: "set_news_subscription";
  category: string;
  hour: number;
  minute: number;
}

export interface PlannedShowNewsSubscriptionAction {
  type: "show_news_subscription";
}

export interface PlannedDeleteNewsSubscriptionAction {
  type: "delete_news_subscription";
}

export interface PlannedListRemindersAction {
  type: "list_reminders";
  filter?: string | null;
}

export interface PlannedListTasksAction {
  type: "list_tasks";
}

export interface PlannedDeleteReminderAction {
  type: "delete_reminder";
  mode: "single" | "ids" | "count" | "all";
  ids?: number[];
  count?: number;
  queryText?: string | null;
  listPosition?: number | null;
}

export interface PlannedDeleteTaskAction {
  type: "delete_task";
  mode: "single" | "ids" | "count" | "all";
  ids?: number[];
  count?: number;
  queryText?: string | null;
  listPosition?: number | null;
}

export interface PlannedAdjustReminderAction {
  type: "adjust_reminder";
  id?: number | null;
  instructions: string;
}

export interface PlannedAskClarificationAction {
  type: "ask_clarification";
  question: string;
}

export type PlannedAction =
  | PlannedCreateReminderAction
  | PlannedCreateTaskAction
  | PlannedAnswerUserAction
  | PlannedFetchNewsAction
  | PlannedSetNewsSubscriptionAction
  | PlannedShowNewsSubscriptionAction
  | PlannedDeleteNewsSubscriptionAction
  | PlannedListRemindersAction
  | PlannedListTasksAction
  | PlannedDeleteReminderAction
  | PlannedDeleteTaskAction
  | PlannedAdjustReminderAction
  | PlannedAskClarificationAction;

export interface MessageActionPlan {
  version: string;
  actions: PlannedAction[];
  needsClarification: boolean;
  clarificationQuestion?: string | null;
}

export interface MessageActionPlanParseResult {
  rawOutput: string | null;
  plan: MessageActionPlan | null;
  validationErrors: string[];
}

export interface MessageActionPlanNormalizationResult extends MessageActionPlanParseResult {
  normalizationErrors: string[];
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

export type NewsSubscriptionStatus = "active" | "disabled";

export interface NewsSubscriptionRecord {
  id: number;
  chatId: number;
  userId: number;
  category: string;
  timezone: string;
  scheduleHour: number;
  scheduleMinute: number;
  nextRunAtUtc: string;
  status: NewsSubscriptionStatus;
  lastSentAtUtc: string | null;
  errorMessage: string | null;
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
