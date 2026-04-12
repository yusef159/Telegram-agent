import type { UserMemoryFact } from "../../types/domain";
import type { AppDatabase } from "../sqlite";

interface UserMemoryRow {
  id: number;
  chat_id: number;
  user_id: number;
  fact_key: string;
  fact_text: string;
  score: number;
  created_at: string;
  updated_at: string;
}

export class UserMemoryRepository {
  constructor(private readonly db: AppDatabase) {}

  async getTopFacts(chatId: number, userId: number, limit = 6): Promise<UserMemoryFact[]> {
    const rows = await this.db.all<UserMemoryRow[]>(
      `
      SELECT id, chat_id, user_id, fact_key, fact_text, score, created_at, updated_at
      FROM user_memory
      WHERE chat_id = ? AND user_id = ?
      ORDER BY score DESC, updated_at DESC
      LIMIT ?
      `,
      chatId,
      userId,
      limit
    );

    return rows.map(mapUserMemoryRow);
  }

  async upsertFact(params: {
    chatId: number;
    userId: number;
    factText: string;
    score?: number;
  }): Promise<void> {
    const factText = normalizeFactText(params.factText);
    if (!factText) {
      return;
    }

    const factKey = buildFactKey(factText);
    const nowIso = new Date().toISOString();
    const score = clampScore(params.score ?? 0.5);

    await this.db.run(
      `
      INSERT INTO user_memory
      (chat_id, user_id, fact_key, fact_text, score, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, user_id, fact_key) DO UPDATE SET
        fact_text = excluded.fact_text,
        score = MAX(user_memory.score, excluded.score),
        updated_at = excluded.updated_at
      `,
      params.chatId,
      params.userId,
      factKey,
      factText,
      score,
      nowIso,
      nowIso
    );
  }

  async pruneFacts(chatId: number, userId: number, maxFacts = 50): Promise<void> {
    await this.db.run(
      `
      DELETE FROM user_memory
      WHERE chat_id = ? AND user_id = ? AND id NOT IN (
        SELECT id FROM user_memory
        WHERE chat_id = ? AND user_id = ?
        ORDER BY score DESC, updated_at DESC
        LIMIT ?
      )
      `,
      chatId,
      userId,
      chatId,
      userId,
      maxFacts
    );
  }
}

function normalizeFactText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function buildFactKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function mapUserMemoryRow(row: UserMemoryRow): UserMemoryFact {
  return {
    id: row.id,
    chatId: row.chat_id,
    userId: row.user_id,
    factKey: row.fact_key,
    factText: row.fact_text,
    score: row.score,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
