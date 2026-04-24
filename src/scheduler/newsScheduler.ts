import schedule, { Job } from "node-schedule";
import { DateTime } from "luxon";

import { env } from "../config/env";
import { NewsSubscriptionsRepository } from "../db/repositories/newsSubscriptionsRepo";
import { NewsService } from "../news/newsService";

export class NewsScheduler {
  private job: Job | null = null;
  private isRunningTick = false;

  constructor(
    private readonly newsSubscriptionsRepo: NewsSubscriptionsRepository,
    private readonly newsService: NewsService,
    private readonly sendNews: (chatId: number, message: string) => Promise<boolean>
  ) {}

  start(): void {
    const seconds = Math.max(30, env.NEWS_SCHEDULER_INTERVAL_SECONDS);
    const expression = `*/${seconds} * * * * *`;

    this.job = schedule.scheduleJob(expression, async () => {
      await this.tick();
    });

    void this.tick();
    console.log(`News scheduler started with ${seconds}s interval.`);
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
      const dueSubscriptions = await this.newsSubscriptionsRepo.getDueActiveSubscriptions(nowIso);

      for (const subscription of dueSubscriptions) {
        try {
          const digest = await this.newsService.buildDigest({
            category: subscription.category,
            maxItems: env.NEWS_MAX_ITEMS
          });

          const sent = await this.sendNews(subscription.chatId, digest);
          if (!sent) {
            const retryIso = DateTime.utc().plus({ minutes: 15 }).toISO() ?? nowIso;
            await this.newsSubscriptionsRepo.markFailedAndScheduleRetry(
              subscription.id,
              "Telegram send returned false for scheduled news digest.",
              retryIso
            );
            continue;
          }

          const nowLocal = DateTime.now().setZone(subscription.timezone);
          let nextRunLocal = nowLocal.set({
            hour: subscription.scheduleHour,
            minute: subscription.scheduleMinute,
            second: 0,
            millisecond: 0
          });
          if (nextRunLocal <= nowLocal) {
            nextRunLocal = nextRunLocal.plus({ days: 1 });
          }

          await this.newsSubscriptionsRepo.markSentAndScheduleNext(
            subscription.id,
            DateTime.utc().toISO() ?? nowIso,
            nextRunLocal.toUTC().toISO() ?? nowIso
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown scheduled news delivery error";
          const retryIso = DateTime.utc().plus({ minutes: 15 }).toISO() ?? nowIso;
          await this.newsSubscriptionsRepo.markFailedAndScheduleRetry(
            subscription.id,
            errorMessage,
            retryIso
          );
        }
      }
    } catch (error) {
      console.error("News scheduler tick failed:", error);
    } finally {
      this.isRunningTick = false;
    }
  }
}
