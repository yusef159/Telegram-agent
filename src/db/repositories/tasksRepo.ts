import type { TaskRecord, TaskStatus } from "../../types/domain";
import type { AppDatabase } from "../sqlite";

interface TaskRow {
  id: number;
  chat_id: number;
  user_id: number;
  task: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export class TasksRepository {
  constructor(private readonly db: AppDatabase) {}

  async createTask(params: { chatId: number; userId: number; task: string }): Promise<number> {
    const nowIso = new Date().toISOString();
    const result = await this.db.run(
      `
      INSERT INTO tasks
      (chat_id, user_id, task, status, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
      `,
      params.chatId,
      params.userId,
      params.task,
      nowIso,
      nowIso
    );

    return result.lastID ?? 0;
  }

  async getPendingTasksByChat(chatId: number, limit = 50): Promise<TaskRecord[]> {
    const rows = await this.db.all<TaskRow[]>(
      `
      SELECT id, chat_id, user_id, task, status, created_at, updated_at
      FROM tasks
      WHERE chat_id = ? AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
      `,
      chatId,
      limit
    );

    return rows.map(mapTaskRow);
  }

  async getPendingTaskById(chatId: number, taskId: number): Promise<TaskRecord | null> {
    const row = await this.db.get<TaskRow>(
      `
      SELECT id, chat_id, user_id, task, status, created_at, updated_at
      FROM tasks
      WHERE chat_id = ? AND id = ? AND status = 'pending'
      `,
      chatId,
      taskId
    );

    return row ? mapTaskRow(row) : null;
  }

  async getLatestPendingTaskByText(chatId: number, taskText: string): Promise<TaskRecord | null> {
    const normalizedTask = taskText.trim();
    if (!normalizedTask) {
      return null;
    }

    const row = await this.db.get<TaskRow>(
      `
      SELECT id, chat_id, user_id, task, status, created_at, updated_at
      FROM tasks
      WHERE chat_id = ? AND status = 'pending' AND LOWER(TRIM(task)) = LOWER(TRIM(?))
      ORDER BY created_at DESC
      LIMIT 1
      `,
      chatId,
      normalizedTask
    );

    return row ? mapTaskRow(row) : null;
  }

  async getExistingPendingTask(chatId: number, taskText: string): Promise<TaskRecord | null> {
    return this.getLatestPendingTaskByText(chatId, taskText);
  }

  async cancelPendingTask(taskId: number): Promise<void> {
    const nowIso = new Date().toISOString();
    await this.db.run(
      `
      UPDATE tasks
      SET status = 'cancelled', updated_at = ?
      WHERE id = ? AND status = 'pending'
      `,
      nowIso,
      taskId
    );
  }

  async cancelAllPendingTasksByChat(chatId: number): Promise<number> {
    const nowIso = new Date().toISOString();
    const result = await this.db.run(
      `
      UPDATE tasks
      SET status = 'cancelled', updated_at = ?
      WHERE chat_id = ? AND status = 'pending'
      `,
      nowIso,
      chatId
    );

    return result.changes ?? 0;
  }
}

function mapTaskRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    userId: row.user_id,
    task: row.task,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
