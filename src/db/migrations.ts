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

  await db.exec(`
    CREATE TABLE IF NOT EXISTS news_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      topic_query TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
      schedule_hour INTEGER NOT NULL,
      schedule_minute INTEGER NOT NULL,
      next_run_at_utc TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      last_sent_at_utc TEXT NULL,
      error_message TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  await ensureNewsSubscriptionsSchema(db);

  const reminderColumns = (await db.all(`PRAGMA table_info(reminders);`)) as Array<{ name: string }>;
  const hasRecurrence = reminderColumns.some((column: { name: string }) => column.name === "recurrence_json");
  if (!hasRecurrence) {
    await db.exec(`ALTER TABLE reminders ADD COLUMN recurrence_json TEXT NULL;`);
  }
}

async function ensureNewsSubscriptionsSchema(db: AppDatabase): Promise<void> {
  const columns = (await db.all(`PRAGMA table_info(news_subscriptions);`)) as Array<{ name: string }>;
  const hasTopicQuery = columns.some((column) => column.name === "topic_query");
  const hasCategory = columns.some((column) => column.name === "category");

  const indexRows = (await db.all(`PRAGMA index_list(news_subscriptions);`)) as Array<{
    name: string;
    unique: number;
  }>;
  let hasUniqueChatIdConstraint = false;

  for (const indexRow of indexRows) {
    if (indexRow.unique !== 1) {
      continue;
    }
    const indexedColumns = (await db.all(`PRAGMA index_info(${quoteSqlLiteral(indexRow.name)});`)) as Array<{
      name: string;
    }>;
    if (indexedColumns.length === 1 && indexedColumns[0]?.name === "chat_id") {
      hasUniqueChatIdConstraint = true;
      break;
    }
  }

  if (!hasTopicQuery || hasUniqueChatIdConstraint) {
    await db.exec(`
      CREATE TABLE news_subscriptions_next (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        topic_query TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
        schedule_hour INTEGER NOT NULL,
        schedule_minute INTEGER NOT NULL,
        next_run_at_utc TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        last_sent_at_utc TEXT NULL,
        error_message TEXT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    if (hasTopicQuery) {
      await db.exec(`
        INSERT INTO news_subscriptions_next (
          id, chat_id, user_id, topic_query, timezone, schedule_hour, schedule_minute,
          next_run_at_utc, status, last_sent_at_utc, error_message, created_at, updated_at
        )
        SELECT
          id, chat_id, user_id, topic_query, timezone, schedule_hour, schedule_minute,
          next_run_at_utc, status, last_sent_at_utc, error_message, created_at, updated_at
        FROM news_subscriptions;
      `);
    } else if (hasCategory) {
      await db.exec(`
        INSERT INTO news_subscriptions_next (
          id, chat_id, user_id, topic_query, timezone, schedule_hour, schedule_minute,
          next_run_at_utc, status, last_sent_at_utc, error_message, created_at, updated_at
        )
        SELECT
          id, chat_id, user_id, category, timezone, schedule_hour, schedule_minute,
          next_run_at_utc, status, last_sent_at_utc, error_message, created_at, updated_at
        FROM news_subscriptions;
      `);
    }

    await db.exec(`DROP TABLE news_subscriptions;`);
    await db.exec(`ALTER TABLE news_subscriptions_next RENAME TO news_subscriptions;`);
  }

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_news_subscriptions_status_due
    ON news_subscriptions(status, next_run_at_utc);
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_news_subscriptions_chat_status
    ON news_subscriptions(chat_id, status);
  `);

  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_news_subscriptions_chat_topic_schedule
    ON news_subscriptions(chat_id, topic_query, schedule_hour, schedule_minute);
  `);
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
