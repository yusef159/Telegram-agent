import { Telegraf } from "telegraf";

import { env } from "../config/env";
import { OpenAiClient } from "../ai/openaiClient";
import { MessageRouter } from "./messageRouter";

export class TelegramBotService {
  private readonly bot: Telegraf;
  private static readonly COMMANDS: Array<{ command: string; description: string }> = [
    { command: "start", description: "Show welcome message" },
    { command: "reminders", description: "Show pending reminders" },
    { command: "tasks", description: "Show pending tasks" },
    { command: "all", description: "Show reminders and tasks" },
    { command: "news", description: "Show your news subscriptions" },
    { command: "help", description: "Show available commands" }
  ];

  constructor(
    private readonly messageRouter: MessageRouter,
    private readonly openAiClient: OpenAiClient
  ) {
    this.bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);
  }

  setupHandlers(): void {
    this.bot.start(async (ctx) => {
      await this.safeReply(
        ctx.chat.id,
        "Hi! I can chat with you and set reminders from natural language. Example: Remind me to review logs in 2 hours."
      );
    });

    this.bot.on("text", async (ctx, next) => {
      const incomingText = ctx.message.text ?? "";
      // Let explicit slash commands flow to command handlers.
      if (incomingText.trim().startsWith("/")) {
        await next();
        return;
      }
      try {
        const reply = await this.messageRouter.routeTextMessage({
          chatId: ctx.chat.id,
          userId: ctx.from.id,
          text: incomingText,
          quotedMessageText: extractQuotedMessageText(ctx.message)
        });
        await this.safeReply(ctx.chat.id, reply);
      } catch (error) {
        console.error("Failed to handle incoming text:", error);
        await this.safeReply(
          ctx.chat.id,
          "I hit an internal error while processing that. Please try again in a moment."
        );
      }
    });

    this.bot.on("voice", async (ctx) => {
      await this.handleVoiceOrAudio(ctx.chat.id, ctx.from.id, ctx.message.voice.file_id);
    });

    this.bot.on("audio", async (ctx) => {
      await this.handleVoiceOrAudio(ctx.chat.id, ctx.from.id, ctx.message.audio.file_id);
    });

    this.bot.on("photo", async (ctx) => {
      await this.handlePhoto(
        ctx.chat.id,
        ctx.message.photo,
        ctx.message.caption ?? "Please analyze this image."
      );
    });

    this.bot.command("reminders", async (ctx) => {
      await this.handleShortcutCommand(ctx.chat.id, "reminders");
    });

    // Keep this alias because users often type this typo.
    this.bot.command("remiders", async (ctx) => {
      await this.handleShortcutCommand(ctx.chat.id, "reminders");
    });

    this.bot.command("tasks", async (ctx) => {
      await this.handleShortcutCommand(ctx.chat.id, "tasks");
    });

    this.bot.command("all", async (ctx) => {
      await this.handleShortcutCommand(ctx.chat.id, "all");
    });

    this.bot.command("news", async (ctx) => {
      await this.handleNewsSubscriptionCommand(ctx.chat.id);
    });

    this.bot.command("help", async (ctx) => {
      const helpText = [
        "Available commands:",
        "/reminders - Show pending reminders",
        "/remiders - Same as reminders",
        "/tasks - Show pending tasks",
        "/all - Show reminders and tasks",
        "/news - Show your current news subscriptions",
        '/help - Show this help',
        "",
        "News examples:",
        '• "Provide me news about OpenAI every morning at 9 am"',
        '• "Show my news subscriptions"',
        '• "Cancel news subscription #3"',
        '• "Cancel all news subscriptions"'
      ].join("\n");
      await this.safeReply(ctx.chat.id, helpText);
    });
  }

  async launch(): Promise<void> {
    try {
      await this.bot.telegram.setMyCommands(TelegramBotService.COMMANDS);
    } catch (error) {
      console.error("Failed to configure Telegram command menu:", error);
    }
    await this.bot.launch();
    console.log("Telegram bot is running.");
  }

  async stop(reason: string): Promise<void> {
    this.bot.stop(reason);
  }

  async safeReply(chatId: number, message: string): Promise<boolean> {
    try {
      await this.bot.telegram.sendMessage(chatId, message);
      return true;
    } catch (error) {
      console.error("Failed to send Telegram message:", error);
      return false;
    }
  }

  private async handleVoiceOrAudio(
    chatId: number,
    userId: number,
    telegramFileId: string
  ): Promise<void> {
    try {
      const fileUrl = await this.bot.telegram.getFileLink(telegramFileId);
      const response = await fetch(fileUrl.toString());

      if (!response.ok) {
        throw new Error(`Failed to fetch voice file. Status=${response.status}`);
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      const transcript = await this.openAiClient.transcribeVoiceNote(audioBuffer);

      if (!transcript) {
        await this.safeReply(
          chatId,
          "I could not understand that voice message. Please try speaking more clearly."
        );
        return;
      }

      const reply = await this.messageRouter.routeTextMessage({
        chatId,
        userId,
        text: transcript
      });

      await this.safeReply(chatId, reply);
    } catch (error) {
      console.error("Failed to handle voice/audio message:", error);
      await this.safeReply(
        chatId,
        "I could not process that voice message right now. Please try again in a moment."
      );
    }
  }

  private async handlePhoto(
    chatId: number,
    photos: Array<{ file_id: string }>,
    caption: string
  ): Promise<void> {
    try {
      const largestPhoto = photos[photos.length - 1];
      if (!largestPhoto) {
        await this.safeReply(chatId, "I could not access that image. Please send it again.");
        return;
      }

      const fileUrl = await this.bot.telegram.getFileLink(largestPhoto.file_id);
      const response = await fetch(fileUrl.toString());
      if (!response.ok) {
        throw new Error(`Failed to fetch image file. Status=${response.status}`);
      }

      const imageBuffer = Buffer.from(await response.arrayBuffer());
      const mimeType = response.headers.get("content-type") ?? "image/jpeg";
      const prompt =
        caption.trim().length > 0
          ? caption.trim()
          : "Please describe what is in this image and give a helpful response.";

      const reply = await this.openAiClient.generateImageReply({
        prompt,
        imageBuffer,
        mimeType
      });

      await this.safeReply(chatId, reply);
    } catch (error) {
      console.error("Failed to handle photo message:", error);
      await this.safeReply(
        chatId,
        "I could not process that image right now. Please try again in a moment."
      );
    }
  }

  private async handleShortcutCommand(
    chatId: number,
    command: "reminders" | "tasks" | "all" | "news"
  ): Promise<void> {
    try {
      const reply = await this.messageRouter.handleShortcutCommand({ chatId, command });
      await this.safeReply(chatId, reply);
    } catch (error) {
      console.error("Failed to handle shortcut command:", error);
      await this.safeReply(chatId, "I couldn't process that command right now. Please try again.");
    }
  }

  private async handleNewsSubscriptionCommand(chatId: number): Promise<void> {
    try {
      const reply = await this.messageRouter.handleShortcutCommand({
        chatId,
        command: "news"
      });
      await this.safeReply(chatId, reply);
    } catch (error) {
      console.error("Failed to handle news command:", error);
      await this.safeReply(chatId, "I couldn't process that command right now. Please try again.");
    }
  }
}

function extractQuotedMessageText(message: unknown): string | undefined {
  const quoted = (message as { reply_to_message?: unknown }).reply_to_message as
    | { text?: string; caption?: string }
    | undefined;
  if (!quoted) {
    return undefined;
  }

  return quoted.text ?? quoted.caption ?? undefined;
}
