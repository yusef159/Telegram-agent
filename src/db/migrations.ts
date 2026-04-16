import type { AppDatabase } from "./sqlite";

export async function runMigrations(db: AppDatabase): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id INTEGER PRIMARY KEY,
      messages_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      due_at_utc TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reminders_status_due
    ON reminders(status, due_at_utc);
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_chat_status
    ON tasks(chat_id, status);
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      fact_key TEXT NOT NULL,
      fact_text TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_memory_unique_fact
    ON user_memory(chat_id, user_id, fact_key);
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_user_memory_lookup
    ON user_memory(chat_id, user_id, score, updated_at);
  `);

  const reminderColumns = (await db.all(`PRAGMA table_info(reminders);`)) as Array<{ name: string }>;
  const hasRecurrence = reminderColumns.some((column: { name: string }) => column.name === "recurrence_json");
  if (!hasRecurrence) {
    await db.exec(`ALTER TABLE reminders ADD COLUMN recurrence_json TEXT NULL;`);
  }
}
