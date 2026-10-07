/**
 * Распознавание команды сотрудника «Админки» — Soniox async (Э6-бис (б),
 * ТЗ помощника §4.10 «„Админка“: голосовые команды — тот же путь
 * „распознал → разобрал“», §5-бис.7; решение Р-Э6б-2).
 *
 * Своя копия сетевой части клиента «Сайта» (`assist-site-voice/public/
 * soniox-stt.client.ts`): «Админка» не импортирует модули «Сайта» (граф
 * admin↛site). Чистая часть (тело транскрипции, разбор токенов, секунды
 * счёта) — общая `shared/soniox-stt-core.ts`. Те же обещания:
 *  - запись — только `Buffer` в памяти запроса: в базу, Blob и логи не
 *    попадает, затирается в `finally` вызывающего (`audio.fill(0)`);
 *  - у провайдера — `DELETE` файла (сначала, звук) и транскрипции в
 *    `finally` при успехе, ошибке и таймауте (Условия п.3.4);
 *  - в лог — ничего от провайдера, кроме кода ответа (§6.6).
 *
 * Билет голоса «Админки» — HMAC над (сайт, сотрудник `jwt:<sub>`, хеш
 * текста, срок): план засчитывает источник `voice`, только если подпись
 * сошлась и текст тот же, что распознан (§5-бис.6 п.1: команда — только из
 * речи или набора в iframe `wa.`).
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { SONIOX_API_BASE, sonioxApiKey } from '../../shared/soniox';
import {
  billedSeconds,
  sonioxTranscriptText,
  sonioxTranscriptionBody,
  type SonioxToken,
} from '../../shared/soniox-stt-core';
import {
  SONIOX_TAG_SITES,
  sonioxFileName,
  sonioxReferenceId,
} from '../../shared/soniox-sweep';

export const ADMIN_STT = {
  /** Запись: ≥ 1 КБ, ≤ 1 МБ (30 с Opus — ≈ 120 КБ). */
  minAudioBytes: 1024,
  maxAudioBytes: 1024 * 1024,
  /** Срок попытки распознавания — сотрудник ждёт с индикатором. */
  attemptDeadlineMs: 20_000,
  /** Резерв денег до вызова: 30 с. */
  reserveSeconds: 30,
  /** Билет голоса живёт 2 минуты (команда → план). */
  ticketTtlMs: 2 * 60_000,
} as const;

export type AdminAudioMime =
  | 'audio/webm'
  | 'audio/ogg'
  | 'audio/mp4'
  | 'audio/wav'
  | 'audio/aac'
  | 'audio/mpeg';

const AUDIO_MIMES: readonly string[] = [
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/wav',
  'audio/aac',
  'audio/mpeg',
];

/** Заголовок `Content-Type` — только допуск (тип — по байтам). */
export function adminAudioHeaderOk(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  return AUDIO_MIMES.includes(raw.split(';')[0].trim().toLowerCase());
}

/** Контейнер записи по первым байтам (как `sniffAudio` «Сайта»). */
export function sniffAdminAudio(b: Buffer): AdminAudioMime | null {
  if (b.length < 12) return null;
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
    return 'audio/webm';
  const ascii = (from: number, to: number) => b.toString('latin1', from, to);
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(4, 8) === 'ftyp') return 'audio/mp4';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'audio/aac';
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return null;
}

// ── билет голоса «Админки» ────────────────────────────────────────────────

const TICKET = /^a1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

function textHash(text: string): string {
  return createHash('sha256').update(text.trim(), 'utf8').digest('base64url');
}

function sign(
  key: Buffer,
  p: { siteId: string; actor: string; text: string; exp: number },
): string {
  return createHmac('sha256', key)
    .update(`a1|admin|${p.siteId}|${p.actor}|${textHash(p.text)}|${p.exp}`)
    .digest('base64url');
}

export function issueAdminVoiceTicket(
  key: Buffer,
  p: { siteId: string; actor: string; text: string; now: Date },
): string {
  const exp = Math.floor((p.now.getTime() + ADMIN_STT.ticketTtlMs) / 1000);
  return `a1.${exp}.${sign(key, { ...p, exp })}`;
}

/** Билет наш, этого сотрудника этого сайта, на этот текст и не истёк. */
export function verifyAdminVoiceTicket(
  key: Buffer | null,
  ticket: unknown,
  p: { siteId: string; actor: string; text: string; now: Date },
): boolean {
  if (!key || typeof ticket !== 'string') return false;
  const m = TICKET.exec(ticket);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp * 1000 <= p.now.getTime()) return false;
  const want = Buffer.from(sign(key, { ...p, exp }));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got);
}

// ── сеть Soniox ───────────────────────────────────────────────────────────

export interface AdminSttResult {
  text: string | null;
  reason?: 'no_key' | 'empty' | 'no_speech' | 'error' | 'timeout';
  language: string | null;
  seconds: number;
  /** Задача у Soniox создана — вызов оплачен, даже без текста. */
  billable: boolean;
}

const REQUEST_TIMEOUT_MS = 8_000;
const POLL_DELAY_MS = 500;
const CLEANUP_GRACE_MS = 6_000;

class SonioxHttpError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`Soniox ${path}: ${status}`);
    this.name = 'SonioxHttpError';
  }
}

function errName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

@Injectable()
export class AdminSonioxStt {
  private readonly logger = new Logger(AdminSonioxStt.name);
  /** Тесты подменяют сеть, env и сроки. */
  fetch: typeof fetch = (...a) => fetch(...a);
  env: NodeJS.ProcessEnv = process.env;
  attemptDeadlineMs: number = ADMIN_STT.attemptDeadlineMs;
  pollDelayMs = POLL_DELAY_MS;
  cleanupGraceMs = CLEANUP_GRACE_MS;

  configured(): boolean {
    return !!sonioxApiKey(this.env);
  }

  /** Никогда не бросает: отказ провайдера — `text: null` с причиной. */
  async transcribe(req: {
    audio: Buffer;
    mimeType: string;
    languageHints: readonly string[];
    /** `context.terms` — имена и фразы мемо «Админки» (admin-stt-terms.ts). */
    terms?: readonly string[];
  }): Promise<AdminSttResult> {
    const key = sonioxApiKey(this.env);
    const none = (reason: AdminSttResult['reason']): AdminSttResult => ({
      text: null,
      reason,
      language: null,
      seconds: 0,
      billable: false,
    });
    if (!key) return none('no_key');
    if (req.audio.length === 0) return none('empty');
    const deadline = Date.now() + this.attemptDeadlineMs;
    let fileId: string | null = null;
    let transcriptionId: string | null = null;
    let audioMs: number | null = null;
    const fail = (reason: AdminSttResult['reason']): AdminSttResult => ({
      text: null,
      reason,
      language: null,
      seconds: billedSeconds(audioMs, 0),
      billable: transcriptionId !== null,
    });
    try {
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(req.audio)], { type: req.mimeType }),
        // Метка сайтов (C4 захода 8): уборка по списку в assist-retention
        // удаляет только своё.
        sonioxFileName(SONIOX_TAG_SITES, 'admin'),
      );
      form.append(
        'client_reference_id',
        sonioxReferenceId(SONIOX_TAG_SITES, 'admin'),
      );
      const uploaded = await this.call<{ id: string }>(
        key,
        '/files',
        deadline,
        {
          method: 'POST',
          body: form,
        },
      );
      fileId = uploaded.id;
      const created = await this.call<{ id: string }>(
        key,
        '/transcriptions',
        deadline,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_reference_id: sonioxReferenceId(SONIOX_TAG_SITES, 'admin'),
            ...sonioxTranscriptionBody(fileId, {
              languageHints: req.languageHints,
              terms: req.terms ?? [],
            }),
          }),
        },
      );
      transcriptionId = created.id;
      while (Date.now() < deadline) {
        await this.sleep(this.pollDelayMs);
        const st = await this.call<{
          status: string;
          audio_duration_ms?: number;
        }>(key, `/transcriptions/${transcriptionId}`, deadline);
        if (typeof st.audio_duration_ms === 'number')
          audioMs = st.audio_duration_ms;
        if (st.status === 'completed') {
          const t = await this.call<{ text?: string; tokens?: SonioxToken[] }>(
            key,
            `/transcriptions/${transcriptionId}/transcript`,
            deadline,
          );
          const parsed = sonioxTranscriptText(t);
          const seconds = billedSeconds(audioMs, parsed.seconds);
          return parsed.text
            ? {
                text: parsed.text,
                language: parsed.language,
                seconds,
                billable: true,
              }
            : { ...fail('no_speech'), seconds };
        }
        if (st.status === 'error') return fail('error');
      }
      return fail('timeout');
    } catch (e) {
      const timeout = e instanceof Error && e.name === 'TimeoutError';
      this.logger.warn(
        `распознавание «Админки» не удалось: ${e instanceof SonioxHttpError ? `${e.path.replace(/^(\/(?:files|transcriptions))\/[^/]+/, '$1/:id')} ${e.status}` : timeout ? 'таймаут' : errName(e)}`,
      );
      return fail(timeout ? 'timeout' : 'error');
    } finally {
      // Обещание Условий (3.4): запись не остаётся у провайдера.
      await this.cleanup(key, transcriptionId, fileId);
    }
  }

  /** Сначала файл (звук), затем транскрипция; 409 — подождать и повторить. */
  private async cleanup(
    key: string,
    transcriptionId: string | null,
    fileId: string | null,
  ): Promise<void> {
    if (fileId) await this.remove(key, `/files/${fileId}`);
    if (!transcriptionId) return;
    const graceUntil = Date.now() + this.cleanupGraceMs;
    for (;;) {
      const status = await this.remove(
        key,
        `/transcriptions/${transcriptionId}`,
      );
      if (status !== 409) return;
      if (Date.now() >= graceUntil) {
        this.logger.warn(
          'Soniox: транскрипция «Админки» ещё обрабатывается — звук удалён, текст уберёт крон assist-retention (своего срока хранения у Soniox нет)',
        );
        return;
      }
      await this.sleep(this.pollDelayMs);
    }
  }

  private async remove(key: string, path: string): Promise<number> {
    try {
      const res = await this.fetch(`${SONIOX_API_BASE}${path}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok && res.status !== 404 && res.status !== 409)
        this.logger.warn(`Soniox: уборка вернула ${res.status}`);
      return res.status;
    } catch (e) {
      this.logger.warn(`Soniox: уборка не удалась: ${errName(e)}`);
      return 0;
    }
  }

  private async call<T>(
    key: string,
    path: string,
    deadline: number,
    init: RequestInit = {},
  ): Promise<T> {
    const left = Math.max(
      1,
      Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()),
    );
    const res = await this.fetch(`${SONIOX_API_BASE}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(left),
    });
    if (!res.ok) throw new SonioxHttpError(path, res.status);
    return (await res.json()) as T;
  }

  private sleep(ms: number): Promise<void> {
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }
}
