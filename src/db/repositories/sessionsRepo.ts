import type { ChatMessage, SessionRecord } from "../../types/domain";
import type { AppDatabase } from "../sqlite";

interface SessionRow {
  chat_id: number;
  messages_json: string;
  updated_at: string;
}

export class SessionsRepository {
  constructor(private readonly db: AppDatabase) {}

  async getSession(chatId: number): Promise<SessionRecord | null> {
    const row = await this.db.get<SessionRow>(
      "SELECT chat_id, messages_json, updated_at FROM sessions WHERE chat_id = ?",
      chatId
    );

    if (!row) {
      return null;
    }

    const messages = parseMessages(row.messages_json);

    return {
      chatId: row.chat_id,
      messages,
      updatedAt: row.updated_at
    };
  }

  async upsertSession(chatId: number, messages: ChatMessage[]): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.db.run(
      `
      INSERT INTO sessions (chat_id, messages_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        messages_json = excluded.messages_json,
        updated_at = excluded.updated_at
      `,
      chatId,
      JSON.stringify(messages),
      nowIso
    );
  }
}

function parseMessages(messagesJson: string): ChatMessage[] {
  try {
    const parsed = JSON.parse(messagesJson) as ChatMessage[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        typeof message.createdAt === "string"
    );
  } catch {
    return [];
  }
}
