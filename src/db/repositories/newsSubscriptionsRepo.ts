import type { NewsSubscriptionRecord } from "../../types/domain";
import type { AppDatabase } from "../sqlite";

interface NewsSubscriptionRow {
  id: number;
  chat_id: number;
  user_id: number;
  topic_query: string;
  timezone: string;
  schedule_hour: number;
  schedule_minute: number;
  next_run_at_utc: string;
  status: NewsSubscriptionRecord["status"];
  last_sent_at_utc: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export class NewsSubscriptionsRepository {
  constructor(private readonly db: AppDatabase) {}

  async upsertSubscription(params: {
    chatId: number;
    userId: number;
    topicQuery: string;
    timezone: string;
    scheduleHour: number;
    scheduleMinute: number;
    nextRunAtUtc: string;
  }): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.db.run(
      `
      INSERT INTO news_subscriptions (
        chat_id,
        user_id,
        topic_query,
        timezone,
        schedule_hour,
        schedule_minute,
        next_run_at_utc,
        status,
        last_sent_at_utc,
        error_message,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?, ?)
      ON CONFLICT(chat_id, topic_query, schedule_hour, schedule_minute) DO UPDATE SET
        user_id = excluded.user_id,
        topic_query = excluded.topic_query,
        timezone = excluded.timezone,
        schedule_hour = excluded.schedule_hour,
        schedule_minute = excluded.schedule_minute,
        next_run_at_utc = excluded.next_run_at_utc,
        status = 'active',
        error_message = NULL,
        updated_at = excluded.updated_at
      `,
      params.chatId,
      params.userId,
      params.topicQuery,
      params.timezone,
      params.scheduleHour,
      params.scheduleMinute,
      params.nextRunAtUtc,
      nowIso,
      nowIso
    );
  }

  async listSubscriptionsByChat(chatId: number): Promise<NewsSubscriptionRecord[]> {
    const rows = await this.db.all<NewsSubscriptionRow[]>(
      `
      SELECT id, chat_id, user_id, topic_query, timezone, schedule_hour, schedule_minute,
             next_run_at_utc, status, last_sent_at_utc, error_message, created_at, updated_at
      FROM news_subscriptions
      WHERE chat_id = ? AND status = 'active'
      ORDER BY schedule_hour ASC, schedule_minute ASC, id ASC
      `,
      chatId
    );
    return rows.map(mapNewsSubscriptionRow);
  }

  async getSubscriptionById(chatId: number, id: number): Promise<NewsSubscriptionRecord | null> {
    const row = await this.db.get<NewsSubscriptionRow>(
      `
      SELECT id, chat_id, user_id, topic_query, timezone, schedule_hour, schedule_minute,
             next_run_at_utc, status, last_sent_at_utc, error_message, created_at, updated_at
      FROM news_subscriptions
      WHERE chat_id = ? AND id = ? AND status = 'active'
      LIMIT 1
      `,
      chatId,
      id
    );
    return row ? mapNewsSubscriptionRow(row) : null;
  }

  async getDueActiveSubscriptions(nowUtcIso: string, limit = 20): Promise<NewsSubscriptionRecord[]> {
    const rows = await this.db.all<NewsSubscriptionRow[]>(
      `
      SELECT id, chat_id, user_id, topic_query, timezone, schedule_hour, schedule_minute,
             next_run_at_utc, status, last_sent_at_utc, error_message, created_at, updated_at
      FROM news_subscriptions
      WHERE status = 'active' AND next_run_at_utc <= ?
      ORDER BY next_run_at_utc ASC
      LIMIT ?
      `,
      nowUtcIso,
      limit
    );
    return rows.map(mapNewsSubscriptionRow);
  }

  async markSentAndScheduleNext(id: number, lastSentAtUtc: string, nextRunAtUtc: string): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.db.run(
      `
      UPDATE news_subscriptions
      SET
        last_sent_at_utc = ?,
        next_run_at_utc = ?,
        error_message = NULL,
        updated_at = ?
      WHERE id = ? AND status = 'active'
      `,
      lastSentAtUtc,
      nextRunAtUtc,
      nowIso,
      id
    );
  }

  async markFailedAndScheduleRetry(id: number, errorMessage: string, nextRunAtUtc: string): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.db.run(
      `
      UPDATE news_subscriptions
      SET
        next_run_at_utc = ?,
        error_message = ?,
        updated_at = ?
      WHERE id = ? AND status = 'active'
      `,
      nextRunAtUtc,
      errorMessage.slice(0, 400),
      nowIso,
      id
    );
  }

  async deleteSubscriptionByChat(chatId: number): Promise<number> {
    const result = await this.db.run(
      `
      DELETE FROM news_subscriptions
      WHERE chat_id = ?
      `,
      chatId
    );
    return result.changes ?? 0;
  }

  async deleteSubscriptionById(chatId: number, subscriptionId: number): Promise<number> {
    const result = await this.db.run(
      `
      DELETE FROM news_subscriptions
      WHERE chat_id = ? AND id = ?
      `,
      chatId,
      subscriptionId
    );
    return result.changes ?? 0;
  }

  async deleteSubscriptionByTopic(chatId: number, topicQuery: string): Promise<number> {
    const result = await this.db.run(
      `
      DELETE FROM news_subscriptions
      WHERE chat_id = ? AND LOWER(topic_query) = LOWER(?)
      `,
      chatId,
      topicQuery.trim()
    );
    return result.changes ?? 0;
  }

  async searchSubscriptionsByTopic(chatId: number, topicQuery: string, limit = 10): Promise<NewsSubscriptionRecord[]> {
    const normalized = `%${topicQuery.trim().toLowerCase()}%`;
    const rows = await this.db.all<NewsSubscriptionRow[]>(
      `
      SELECT id, chat_id, user_id, topic_query, timezone, schedule_hour, schedule_minute,
             next_run_at_utc, status, last_sent_at_utc, error_message, created_at, updated_at
      FROM news_subscriptions
      WHERE chat_id = ?
        AND status = 'active'
        AND LOWER(topic_query) LIKE ?
      ORDER BY schedule_hour ASC, schedule_minute ASC, id ASC
      LIMIT ?
      `,
      chatId,
      normalized,
      limit
    );
    return rows.map(mapNewsSubscriptionRow);
  }

  async deleteSubscriptionByChatAndSchedule(
    chatId: number,
    topicQuery: string,
    scheduleHour: number,
    scheduleMinute: number
  ): Promise<number> {
    const result = await this.db.run(
      `
      DELETE FROM news_subscriptions
      WHERE chat_id = ?
        AND LOWER(topic_query) = LOWER(?)
        AND schedule_hour = ?
        AND schedule_minute = ?
      `,
      chatId,
      topicQuery.trim(),
      scheduleHour,
      scheduleMinute
    );
    return result.changes ?? 0;
  }
}

function mapNewsSubscriptionRow(row: NewsSubscriptionRow): NewsSubscriptionRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    userId: row.user_id,
    topicQuery: row.topic_query,
    timezone: row.timezone,
    scheduleHour: row.schedule_hour,
    scheduleMinute: row.schedule_minute,
    nextRunAtUtc: row.next_run_at_utc,
    status: row.status,
    lastSentAtUtc: row.last_sent_at_utc,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
