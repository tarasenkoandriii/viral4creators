/**
 * Заглушка Gemini для ЛОКАЛЬНОГО запуска sites-backend (интеграционный
 * прогон Э2, контракт §9 п.3: e2e виджета против настоящего бэкенда без
 * ключа и сети). Включается `SITES_DEV_FAKE_GEMINI=true` и ТОЛЬКО вне
 * production — то же правило двух условий, что у dev-входа
 * (shared/dev-login.ts): в проде `NODE_ENV=production` ставит платформа.
 * Флаг в production — не тихий игнор, а отказ: `validateConfiguration`
 * роняет старт, а сама фабрика бросает (второй предохранитель).
 *
 * Что умеет (ровно то, что зовут site-ai и конвейер виджета):
 *  - `embedContent` — «мешок слов» в 768 измерений (одинаковые слова —
 *    близкие векторы): поиск по знаниям работает осмысленно;
 *  - `generateContent` — короткий текстовый вызов (перевод вопроса и пр.):
 *    возвращает вопрос как есть, JSON-режим — `{}`;
 *  - `generateContentStream` — ответ из первого источника промпта с
 *    цитатой `[S<n>]` и кнопкой заявки, кусками с паузой `SITES_DEV_FAKE_GEMINI_DELAY_MS`
 *    (умолчание 60 мс) — хватает, чтобы перезагрузить страницу посреди
 *    стрима. Каждый вызов модели дописывается строкой JSON в файл
 *    `SITES_DEV_FAKE_GEMINI_LOG` (если задан) — e2e считает вызовы.
 *
 * Текста вопроса/ответа в лог сервиса не пишет (§6.6); файл — артефакт
 * стенда, а не лог.
 */
import { appendFileSync } from 'fs';
import type { GoogleGenAI } from '@google/genai';
import { KNOWLEDGE_DEFAULTS } from '../../config/assist-defaults';
import {
  devFakeGeminiEnabled,
  devFakeGeminiProblem,
} from '../../config/dev-ai-env';
import { createGeminiClient } from '../../shared/gemini-client';

/**
 * Клиент Gemini для site-ai и конвейера виджета: настоящий
 * (`createGeminiClient`) или dev-заглушка. Единственная точка выбора.
 */
export function siteGeminiClient(
  env: NodeJS.ProcessEnv = process.env,
): GoogleGenAI {
  const problem = devFakeGeminiProblem(env);
  if (problem) throw new Error(problem);
  if (devFakeGeminiEnabled(env)) {
    return createDevFakeGemini(env) as unknown as GoogleGenAI;
  }
  return createGeminiClient(env);
}

// ── реализация заглушки ─────────────────────────────────────────────────

function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).map((w) =>
    w.slice(0, 6),
  );
}

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** «Мешок слов» → вектор заданной длины (не нулевой). */
export function devFakeEmbedding(
  text: string,
  dims: number = KNOWLEDGE_DEFAULTS.embedDimensions,
): number[] {
  const v = new Array<number>(dims).fill(0);
  v[0] = 0.01;
  for (const w of words(text)) v[fnv(w) % dims] += 1;
  return v;
}

function textOf(contents: unknown): string {
  if (typeof contents === 'string') return contents;
  if (!Array.isArray(contents)) return '';
  return contents
    .map((c) => {
      if (typeof c === 'string') return c;
      const parts = (c as { parts?: Array<{ text?: string }> })?.parts ?? [];
      return parts.map((p) => p.text ?? '').join('');
    })
    .join('\n');
}

/** Ответ «по первому источнику»: первое предложение + цитата. */
export function devFakeAnswer(prompt: string): string {
  const src =
    /<source id="S(\d+)"[^>]*>\n([\s\S]*?)\n<\/source>/.exec(prompt) ?? null;
  if (!src) {
    return 'На страницах сайта этого нет — оставьте заявку, менеджер уточнит.';
  }
  const first = src[2].split(/(?<=[.!?])\s+/)[0]?.trim() || src[2].trim();
  // Блок действий — как у настоящей модели (разделитель конвейера): кнопка
  // формы заявки, чтобы стенд проверял лид без ошибок квоты.
  const actions = JSON.stringify({
    items: [{ kind: 'lead', label: 'Оставить заявку' }],
  });
  return `${first} [S${src[1]}]<<<actions>>>${actions}`;
}

function logCall(env: NodeJS.ProcessEnv, op: string): void {
  const file = env.SITES_DEV_FAKE_GEMINI_LOG;
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({ op, at: Date.now() })}\n`);
  } catch {
    // Файл стенда — не повод ронять ответ.
  }
}

interface Args {
  contents?: unknown;
  config?: {
    abortSignal?: AbortSignal;
    responseMimeType?: string;
    outputDimensionality?: number;
  };
}

export function createDevFakeGemini(env: NodeJS.ProcessEnv = process.env) {
  const delayMs = Math.max(
    0,
    Number(env.SITES_DEV_FAKE_GEMINI_DELAY_MS ?? 60) || 0,
  );
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    models: {
      async embedContent(a: Args) {
        logCall(env, 'embed');
        const texts = Array.isArray(a.contents)
          ? a.contents.map((c) => textOf([c]))
          : [textOf(a.contents)];
        const dims =
          a.config?.outputDimensionality ?? KNOWLEDGE_DEFAULTS.embedDimensions;
        return {
          embeddings: texts.map((t) => ({
            values: devFakeEmbedding(t, dims),
            statistics: { tokenCount: Math.max(1, words(t).length) },
          })),
        };
      },
      async generateContent(a: Args) {
        logCall(env, 'text');
        const user = textOf(a.contents);
        const q = /<q>\n([\s\S]*?)\n<\/q>/.exec(user)?.[1] ?? user;
        return {
          text:
            a.config?.responseMimeType === 'application/json'
              ? '{}'
              : q.slice(0, 600),
          usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 20 },
        };
      },
      async generateContentStream(a: Args) {
        logCall(env, 'stream');
        const signal = a.config?.abortSignal;
        const text = devFakeAnswer(textOf(a.contents));
        return {
          async *[Symbol.asyncIterator]() {
            for (let i = 0; i < text.length; i += 8) {
              if (signal?.aborted) throw new Error('aborted');
              if (delayMs) await sleep(delayMs);
              const last = i + 8 >= text.length;
              yield {
                text: text.slice(i, i + 8),
                ...(last
                  ? {
                      usageMetadata: {
                        promptTokenCount: 1200,
                        candidatesTokenCount: Math.ceil(text.length / 4),
                      },
                    }
                  : {}),
              };
            }
          },
        };
      },
    },
  };
}
