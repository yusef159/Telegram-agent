import type { ReminderRecord } from "../../types/domain";
import type { AppDatabase } from "../sqlite";

interface ReminderRow {
  id: number;
  chat_id: number;
  user_id: number;
  message: string;
  due_at_utc: string;
  timezone: string;
  status: ReminderRecord["status"];
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export class RemindersRepository {
  constructor(private readonly db: AppDatabase) {}

  async createReminder(params: {
    chatId: number;
    userId: number;
    message: string;
    dueAtUtc: string;
    timezone: string;
  }): Promise<number> {
    const nowIso = new Date().toISOString();
    const result = await this.db.run(
      `
      INSERT INTO reminders
      (chat_id, user_id, message, due_at_utc, timezone, status, error_message, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
      `,
      params.chatId,
      params.userId,
      params.message,
      params.dueAtUtc,
      params.timezone,
      nowIso,
      nowIso
    );

    return result.lastID ?? 0;
  }

  async getDuePendingReminders(nowUtcIso: string, limit = 50): Promise<ReminderRecord[]> {
    const rows = await this.db.all<ReminderRow[]>(
      `
      SELECT id, chat_id, user_id, message, due_at_utc, timezone, status, error_message, created_at, updated_at
      FROM reminders
      WHERE status = 'pending' AND due_at_utc <= ?
      ORDER BY due_at_utc ASC
      LIMIT ?
      `,
      nowUtcIso,
      limit
    );

    return rows.map(mapReminderRow);
  }

  async getPendingRemindersByChat(chatId: number, limit = 20): Promise<ReminderRecord[]> {
    const rows = await this.db.all<ReminderRow[]>(
      `
      SELECT id, chat_id, user_id, message, due_at_utc, timezone, status, error_message, created_at, updated_at
      FROM reminders
      WHERE chat_id = ? AND status = 'pending'
      ORDER BY due_at_utc ASC
      LIMIT ?
      `,
      chatId,
      limit
    );

    return rows.map(mapReminderRow);
  }

  async getPendingReminderById(chatId: number, reminderId: number): Promise<ReminderRecord | null> {
    const row = await this.db.get<ReminderRow>(
      `
      SELECT id, chat_id, user_id, message, due_at_utc, timezone, status, error_message, created_at, updated_at
      FROM reminders
      WHERE chat_id = ? AND id = ? AND status = 'pending'
      `,
      chatId,
      reminderId
    );

    return row ? mapReminderRow(row) : null;
  }

  async getLatestPendingReminderByMessage(
    chatId: number,
    message: string
  ): Promise<ReminderRecord | null> {
    const normalizedMessage = message.trim();
    if (!normalizedMessage) {
      return null;
    }

    const row = await this.db.get<ReminderRow>(
      `
      SELECT id, chat_id, user_id, message, due_at_utc, timezone, status, error_message, created_at, updated_at
      FROM reminders
      WHERE chat_id = ? AND status = 'pending' AND LOWER(TRIM(message)) = LOWER(TRIM(?))
      ORDER BY due_at_utc DESC
      LIMIT 1
      `,
      chatId,
      normalizedMessage
    );

    return row ? mapReminderRow(row) : null;
  }

  async updatePendingReminder(
    reminderId: number,
    updates: { message: string; dueAtUtc: string }
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.db.run(
      `
      UPDATE reminders
      SET message = ?, due_at_utc = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
      `,
      updates.message,
      updates.dueAtUtc,
      nowIso,
      reminderId
    );
  }

  async markSent(id: number): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.db.run(
      `
      UPDATE reminders
      SET status = 'sent', error_message = NULL, updated_at = ?
      WHERE id = ?
      `,
      nowIso,
      id
    );
  }

  async cancelPendingReminder(id: number): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.db.run(
      `
      UPDATE reminders
      SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status = 'pending'
      `,
      nowIso,
      id
    );
  }

  async cancelAllPendingRemindersByChat(chatId: number): Promise<number> {
    const nowIso = new Date().toISOString();
    const result = await this.db.run(
      `
      UPDATE reminders
      SET status = 'cancelled', updated_at = ?
      WHERE chat_id = ? AND status = 'pending'
      `,
      nowIso,
      chatId
    );

    return result.changes ?? 0;
  }

  async markFailed(id: number, errorMessage: string): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.db.run(
      `
      UPDATE reminders
      SET status = 'failed', error_message = ?, updated_at = ?
      WHERE id = ?
      `,
      errorMessage.slice(0, 400),
      nowIso,
      id
    );
  }
}

function mapReminderRow(row: ReminderRow): ReminderRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    userId: row.user_id,
    message: row.message,
    dueAtUtc: row.due_at_utc,
    timezone: row.timezone,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
