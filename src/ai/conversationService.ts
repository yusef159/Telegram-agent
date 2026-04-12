import { env } from "../config/env";
import { UserMemoryRepository } from "../db/repositories/userMemoryRepo";
import { SessionsRepository } from "../db/repositories/sessionsRepo";
import type { ChatMessage } from "../types/domain";
import { OpenAiClient } from "./openaiClient";

export class ConversationService {
  constructor(
    private readonly openAiClient: OpenAiClient,
    private readonly sessionsRepo: SessionsRepository,
    private readonly userMemoryRepo: UserMemoryRepository
  ) {}

  async replyToUser(chatId: number, userId: number, userMessage: string): Promise<string> {
    const existingSession = await this.sessionsRepo.getSession(chatId);
    const history = existingSession?.messages ?? [];
    const memoryFacts = await this.userMemoryRepo.getTopFacts(chatId, userId, 6);

    const boundedHistory = history.slice(-env.MEMORY_MESSAGE_LIMIT);
    const assistantReply = await this.openAiClient.generateAssistantReply({
      userMessage,
      history: boundedHistory,
      memoryFacts: memoryFacts.map((fact) => fact.factText)
    });

    const userTurn: ChatMessage = {
      role: "user",
      content: userMessage,
      createdAt: new Date().toISOString()
    };
    const assistantTurn: ChatMessage = {
      role: "assistant",
      content: assistantReply,
      createdAt: new Date().toISOString()
    };

    const updatedMessages: ChatMessage[] = [
      ...boundedHistory,
      userTurn,
      assistantTurn
    ].slice(-env.MEMORY_MESSAGE_LIMIT);

    await this.sessionsRepo.upsertSession(chatId, updatedMessages);
    await this.tryLearnLongTermMemory(chatId, userId, userMessage, memoryFacts.map((fact) => fact.factText));
    return assistantReply;
  }

  private async tryLearnLongTermMemory(
    chatId: number,
    userId: number,
    userMessage: string,
    existingFacts: string[]
  ): Promise<void> {
    if (!isMemoryExtractionEligibleByLength(userMessage)) {
      return;
    }

    try {
      const extractedFacts = await this.openAiClient.extractPersonalMemoryFacts({
        userMessage: userMessage.slice(0, 500),
        existingFacts: existingFacts.slice(0, 6)
      });

      for (const fact of extractedFacts) {
        await this.userMemoryRepo.upsertFact({
          chatId,
          userId,
          factText: fact,
          score: 0.7
        });
      }

      await this.userMemoryRepo.pruneFacts(chatId, userId, 50);
    } catch (error) {
      console.error("Failed to update long-term memory:", error);
    }
  }
}

function isMemoryExtractionEligibleByLength(message: string): boolean {
  const normalized = message.toLowerCase();
  if (normalized.length < 8 || normalized.length > 500) {
    return false;
  }
  return true;
}
