import schedule, { Job } from "node-schedule";

import { env } from "../config/env";
import { RemindersRepository } from "../db/repositories/remindersRepo";

export class ReminderScheduler {
  private job: Job | null = null;
  private isRunningTick = false;

  constructor(
    private readonly remindersRepo: RemindersRepository,
    private readonly sendReminder: (chatId: number, message: string) => Promise<boolean>
  ) {}

  start(): void {
    const seconds = Math.max(5, env.SCHEDULER_INTERVAL_SECONDS);
    const expression = `*/${seconds} * * * * *`;

    this.job = schedule.scheduleJob(expression, async () => {
      await this.tick();
    });

    // Run once on startup so overdue reminders are sent quickly.
    void this.tick();
    console.log(`Reminder scheduler started with ${seconds}s interval.`);
  }

  stop(): void {
    if (this.job) {
      this.job.cancel();
      this.job = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.isRunningTick) {
      return;
    }
    this.isRunningTick = true;

    try {
      const nowIso = new Date().toISOString();
      const reminders = await this.remindersRepo.getDuePendingReminders(nowIso);

      for (const reminder of reminders) {
        const text = `⏰ Reminder: ${reminder.message}`;
        try {
          const sent = await this.sendReminder(reminder.chatId, text);
          if (sent) {
            await this.remindersRepo.markSent(reminder.id);
          } else {
            await this.remindersRepo.markFailed(
              reminder.id,
              "Telegram send returned false (send failed)."
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown scheduler send error";
          await this.remindersRepo.markFailed(reminder.id, message);
        }
      }
    } catch (error) {
      console.error("Reminder scheduler tick failed:", error);
    } finally {
      this.isRunningTick = false;
    }
  }
}
