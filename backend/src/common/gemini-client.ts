/**
 * Ключ Gemini — одно место (этап 53, В-6.15).
 *
 * Семь сервисов писали `new GoogleGenAI({})`: SDK в таком виде читает
 * ключ из СВОИХ переменных (`GEMINI_API_KEY`/`GOOGLE_API_KEY`), а наш код
 * при этом принимал и `GOOGLE_GEMINI_API_KEY` — проверял его в
 * конструкторе, печатал «ключ есть» и никуда не передавал. Оператор с
 * одним `GOOGLE_GEMINI_API_KEY` проходил проверку при старте и получал
 * отказ провайдера в рантайме. Теперь ключ читается здесь и передаётся
 * SDK явно; порядок имён тот же, что в `configuration.ts`.
 */
import { GoogleGenAI } from '@google/genai';

export function geminiApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.GEMINI_API_KEY || env.GOOGLE_GEMINI_API_KEY || undefined;
}

/** Клиент с явным ключом. Без ключа — бросает: молча работать нечем. */
export function createGeminiClient(
  env: NodeJS.ProcessEnv = process.env,
): GoogleGenAI {
  const apiKey = geminiApiKey(env);
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY or GOOGLE_GEMINI_API_KEY environment variable is required',
    );
  }
  return new GoogleGenAI({ apiKey });
}
