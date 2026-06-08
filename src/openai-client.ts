import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import type { AppConfig } from "./config.js";

export async function createChatCompletion(
  config: AppConfig,
  params: Omit<ChatCompletionCreateParamsNonStreaming, "model"> & { model?: string }
) {
  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  const primaryModel = params.model ?? config.OPENAI_MODEL;

  try {
    return await retry(() => client.chat.completions.create({ ...params, model: primaryModel }));
  } catch (error) {
    if (config.OPENAI_FALLBACK_MODEL && config.OPENAI_FALLBACK_MODEL !== primaryModel) {
      return retry(() =>
        client.chat.completions.create({ ...params, model: config.OPENAI_FALLBACK_MODEL })
      );
    }
    throw error;
  }
}

async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        break;
      }
      await sleep(500 * attempt);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
