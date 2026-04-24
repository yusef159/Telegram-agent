import { ConversationService } from "./ai/conversationService";
import { IntentParserService } from "./ai/intentParser";
import { OpenAiClient } from "./ai/openaiClient";
import { MessageRouter } from "./bot/messageRouter";
import { TelegramBotService } from "./bot/telegramBot";
import { runMigrations } from "./db/migrations";
import { NewsSubscriptionsRepository } from "./db/repositories/newsSubscriptionsRepo";
import { RemindersRepository } from "./db/repositories/remindersRepo";
import { SessionsRepository } from "./db/repositories/sessionsRepo";
import { TasksRepository } from "./db/repositories/tasksRepo";
import { UserMemoryRepository } from "./db/repositories/userMemoryRepo";
import { createDatabaseConnection } from "./db/sqlite";
import { NewsService } from "./news/newsService";
import { NewsScheduler } from "./scheduler/newsScheduler";
import { ReminderScheduler } from "./scheduler/reminderScheduler";

async function bootstrap(): Promise<void> {
  const db = await createDatabaseConnection();
  await runMigrations(db);

  const sessionsRepo = new SessionsRepository(db);
  const remindersRepo = new RemindersRepository(db);
  const tasksRepo = new TasksRepository(db);
  const newsSubscriptionsRepo = new NewsSubscriptionsRepository(db);
  const userMemoryRepo = new UserMemoryRepository(db);
  const openAiClient = new OpenAiClient();
  const newsService = new NewsService();

  const conversationService = new ConversationService(openAiClient, sessionsRepo, userMemoryRepo);
  const intentParser = new IntentParserService(openAiClient);
  const messageRouter = new MessageRouter(
    openAiClient,
    conversationService,
    intentParser,
    remindersRepo,
    tasksRepo,
    newsSubscriptionsRepo,
    newsService
  );
  const bot = new TelegramBotService(messageRouter, openAiClient);
  const scheduler = new ReminderScheduler(remindersRepo, (chatId, message) =>
    bot.safeReply(chatId, message)
  );
  const newsScheduler = new NewsScheduler(newsSubscriptionsRepo, newsService, (chatId, message) =>
    bot.safeReply(chatId, message)
  );

  bot.setupHandlers();
  // Start scheduler independently so reminders still fire if Telegram launch is slow/hanging.
  scheduler.start();
  newsScheduler.start();
  void bot.launch().catch((error) => {
    console.error("Telegram launch failed:", error);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}. Shutting down...`);
    scheduler.stop();
    newsScheduler.stop();
    await bot.stop(signal);
    await db.close();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

void bootstrap().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
