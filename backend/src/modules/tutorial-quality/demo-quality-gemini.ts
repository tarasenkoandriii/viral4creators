/**
 * demo-quality-gemini.ts — Gemini для очереди проверки качества демо.
 *
 * Почему не `GeminiFilesService.uploadAndWaitActive`: он ждёт обработку
 * файла ВНУТРИ вызова (до двух минут), а очередь хранит загрузку,
 * ожидание и анализ отдельными фазами между тиками крона
 * (doc/TUTORIAL-DEMO-QUALITY-SPEC.md, «Место в существующем кроне», п.3:
 * «выделить upload и проверку состояния файла, не меняя поведение
 * остальных клиентов сервиса»). Поэтому здесь три коротких шага —
 * загрузить, спросить состояние, спросить модель, — а удаление файла
 * идёт через общий `GeminiFilesService.deleteFile` (тот же best-effort).
 *
 * Абстрактный класс — токен DI: тесты подставляют фейк, и ни один тест
 * не ходит в настоящий Gemini.
 */

import { Injectable } from '@nestjs/common';
import { FileState, GoogleGenAI, Schema } from '@google/genai';
import { createGeminiClient } from '../../common/gemini-client';
import { GeminiFilesService } from '../analysis/gemini-files.service';

export type DemoQualityFileState = 'PROCESSING' | 'ACTIVE' | 'FAILED';

export interface DemoQualityGeminiFile {
  name: string;
  state: DemoQualityFileState;
  uri: string | null;
  mimeType: string | null;
  error: string | null;
}

export interface DemoQualityGenerateRequest {
  model: string;
  fileUri: string;
  mimeType: string;
  prompt: string;
  schema: Schema;
  timeoutMs: number;
}

export interface DemoQualityGenerateResult {
  /** Текст ответа (JSON по схеме) или пусто. */
  text: string;
  /** Сырой ответ — для учёта расхода (`usageMetadata`). */
  response: unknown;
  /** Модель отказалась отвечать (safety и т. п.) — причина. */
  refusal: string | null;
}

export abstract class DemoQualityGemini {
  abstract upload(
    bytes: Buffer,
    mimeType: string,
  ): Promise<DemoQualityGeminiFile>;
  abstract getFile(name: string): Promise<DemoQualityGeminiFile>;
  abstract generate(
    req: DemoQualityGenerateRequest,
  ): Promise<DemoQualityGenerateResult>;
  abstract deleteFile(name: string): Promise<void>;
}

function toState(state: unknown): DemoQualityFileState {
  if (state === FileState.ACTIVE) return 'ACTIVE';
  if (state === FileState.FAILED) return 'FAILED';
  return 'PROCESSING';
}

/** Ошибка таймаута анализа — временная (`isTransientError`). */
export class DemoQualityTimeoutError extends Error {
  readonly name = 'TimeoutError';
  constructor(ms: number) {
    super(`анализ не уложился в ${Math.round(ms / 1000)} с`);
  }
}

const REFUSAL_FINISH = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'OTHER',
]);

@Injectable()
export class GoogleDemoQualityGemini extends DemoQualityGemini {
  private client: GoogleGenAI | null = null;

  constructor(private readonly files: GeminiFilesService) {
    super();
  }

  /** Клиент — при первом вызове: выключенная проверка ключа не требует. */
  private genai(): GoogleGenAI {
    if (!this.client) this.client = createGeminiClient();
    return this.client;
  }

  async upload(
    bytes: Buffer,
    mimeType: string,
  ): Promise<DemoQualityGeminiFile> {
    const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
    const f = await this.genai().files.upload({
      file: blob,
      config: { mimeType },
    });
    if (!f.name) throw new Error('Gemini не вернул имя загруженного файла');
    return {
      name: f.name,
      state: toState(f.state),
      uri: f.uri ?? null,
      mimeType: f.mimeType ?? mimeType,
      error: f.error?.message ?? null,
    };
  }

  async getFile(name: string): Promise<DemoQualityGeminiFile> {
    const f = await this.genai().files.get({ name });
    return {
      name,
      state: toState(f.state),
      uri: f.uri ?? null,
      mimeType: f.mimeType ?? null,
      error: f.error?.message ?? null,
    };
  }

  async generate(
    req: DemoQualityGenerateRequest,
  ): Promise<DemoQualityGenerateResult> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DemoQualityTimeoutError(req.timeoutMs));
      }, req.timeoutMs);
    });
    try {
      const res = await Promise.race([
        this.genai().models.generateContent({
          model: req.model,
          contents: [
            { fileData: { fileUri: req.fileUri, mimeType: req.mimeType } },
            { text: req.prompt },
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema: req.schema,
            temperature: 0,
            abortSignal: controller.signal,
          },
        }),
        timeout,
      ]);
      const block = res.promptFeedback?.blockReason;
      const finish = res.candidates?.[0]?.finishReason;
      const refusal = block
        ? `запрос отклонён моделью (${String(block)})`
        : finish && REFUSAL_FINISH.has(String(finish))
          ? `модель прервала ответ (${String(finish)})`
          : null;
      return { text: res.text ?? '', response: res, refusal };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async deleteFile(name: string): Promise<void> {
    await this.files.deleteFile(name);
  }
}
