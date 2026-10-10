import { SonioxObservability } from '../soniox-observability/soniox-observability.service';
/**
 * SonioxSttClient — короткая запись → текст через асинхронный API Soniox.
 * Вариант распознавания рядом с Gemini, выбирается в админке
 * (`common/speech-recognition-provider.ts`).
 *
 * ## Почему асинхронный, а не потоковый
 *
 * Голосовой ввод продукта — запись целиком: «удерживать и говорить» в
 * мастере поздравления и диктовка описания товара. Потоковый режим
 * нужен, когда текст должен появляться, пока человек говорит; здесь
 * запись уже лежит в Blob, и асинхронная модель дешевле ($0.10 против
 * $0.12 за час) и точнее на коротком файле целиком.
 *
 * ## Уборка у провайдера — не улучшение, а обещание Условий
 *
 * Soniox хранит загруженный файл и транскрипт, пока их не удалят. Условия
 * (пункт 3.4, редакция 2026-09-29) обещают, что запись голосового ввода
 * удаляется у ИИ-провайдера сразу после расшифровки. Поэтому `DELETE`
 * транскрипции и файла стоят в `finally` — при успехе, ошибке и
 * таймауте. Уборка best-effort: её отказ не портит результат
 * пользователя. Незавершённую задачу Soniox удалить не даёт (`409`), а
 * собственного срока хранения у него НЕТ (документация async-API,
 * сверено 2026-10-07: «Files are not deleted automatically»; лимит —
 * 2000 транскрипций на аккаунт, включая готовые). Поэтому то, что не
 * удалилось и после ожидания, не теряется: идентификатор уходит в
 * очередь `soniox-pending-delete` (`PlatformSetting`), и метла
 * `voice-uploads-sweep` повторяет удаление каждые 15 минут
 * (`drainSonioxPendingDeletes`, C4 захода 8, ТЗ поздравлений 2.0 стр.
 * 1622). Шов `check-docs.mjs` «голос не остаётся у провайдера» требует
 * обе строки `DELETE` в этом файле.
 *
 * ## Что берём у Soniox такого, чего нет у Gemini
 *
 * - `language_hints` — параметром, а не строкой инструкции;
 * - `language_hints_strict` — на повторе после ответа латиницей;
 * - `context.terms` — имена получателя и отправителя. Devil's Advocate
 *   этого не делал вовсе; строка «Имена» §4А.3 ТЗ Greeting 2.0 наконец
 *   получает механизм провайдера, а не просьбу в тексте.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SONIOX_API_BASE, sonioxApiKey } from '../../common/soniox';
import {
  SONIOX_TAG_GENERATOR,
  sonioxFileName,
  sonioxReferenceId,
} from '../../common/soniox-sweep';
import {
  billedSeconds,
  sonioxTranscriptText,
  sonioxSpeechConfidence,
  sonioxTranscriptionBody,
  type SonioxSttRequest,
  type SonioxToken,
} from '../../common/soniox-stt-core';

// Чистая часть (тело запроса, разбор, язык, секунды) — common/soniox-stt-core.ts
// (её копирует sites-backend); здесь — сеть, сроки и уборка у провайдера.
export {
  billedSeconds,
  dominantSonioxLanguage,
  sonioxTranscriptText,
  sonioxTranscriptionBody,
} from '../../common/soniox-stt-core';
export type { SonioxSttRequest } from '../../common/soniox-stt-core';

export interface SonioxSttResult {
  text: string | null;
  reason?: string;
  /** Длительность записи для счёта — см. `billedSeconds`. */
  seconds: number;
  /**
   * Задача у Soniox была создана — значит, вызов оплачен, даже если
   * текста нет (тишина, ошибка, истёкший срок). По этому признаку, а не
   * по наличию текста, пишется расход.
   */
  billable?: boolean;
  /**
   * Язык, на котором ГОВОРИЛИ, — определён Soniox по звуку, по фрагментам
   * (`enable_language_identification`), наружу — преобладающий. `null` —
   * провайдер языка не сообщил. Запрос владельца 29.09.2026: помощник
   * узнаёт язык человека из его речи, а не из настроек.
   */
  language?: string | null;
  /**
   * Длительность звука по данным самого Soniox, мс (`audio_duration_ms`);
   * `null` — обработка до неё не дошла. По ней мастер поздравления
   * отвергает запись длиннее минуты (финальный аудит ветки K).
   */
  audioMs?: number | null;
  speechConfidence?: number | null;
}

/**
 * Срок одной попытки целиком: загрузка, задача, опрос, текст. Короткая
 * реплика распознаётся за секунды; 20 секунд с запасом покрывают и
 * минутную диктовку, и оставляют место второй попытке мастера
 * поздравления и запасному пути через Gemini внутри одного вызова
 * функции и клиентского таймаута в 120 секунд.
 */
const ATTEMPT_DEADLINE_MS = 20_000;
/** Потолок одного запроса; внутри срока попытки — меньшее из двух. */
const REQUEST_TIMEOUT_MS = 8_000;
const POLL_DELAY_MS = 1_000;
/** Сколько ждать конца обработки, чтобы удалить транскрипцию после 409. */
const CLEANUP_GRACE_MS = 6_000;

interface SonioxTranscriptionStatus {
  status: string;
  error_message?: string;
  /** Длительность звука, мс; есть, когда обработка началась. */
  audio_duration_ms?: number;
}

// ── Очередь неудалённого у Soniox (C4 захода 8) ─────────────────────────

/** Ключ `PlatformSetting`: JSON-массив `SonioxPendingDelete`. */
export const SONIOX_PENDING_DELETE_KEY = 'soniox-pending-delete';
/**
 * Потолок очереди. Запись ~120 байт → ~60 КБ строки: столько не
 * удалённого бывает, только если Soniox лежит часами, и тогда важнее не
 * раздуть строку настроек, чем помнить самый старый id (он уйдёт в лог).
 */
export const SONIOX_PENDING_DELETE_MAX_ENTRIES = 500;
/**
 * Попыток метлы на одну запись. Метла ходит раз в 15 минут: 96 попыток
 * — сутки. Обработка короткой реплики идёт секунды; если сутки подряд
 * Soniox отвечает не «удалено» и не «нет такого», дальше повторять
 * бессмысленно — запись уходит в лог для ручной уборки.
 */
export const SONIOX_PENDING_DELETE_MAX_ATTEMPTS = 96;
/**
 * Срок, после которого запись снимается с очереди без удаления, даже
 * если попыток было меньше (метла стояла). Своего срока хранения у
 * Soniox нет (см. шапку) — это НАШ предел, после которого id в логе
 * — сигнал оператору удалить вручную.
 */
export const SONIOX_PENDING_DELETE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Удалений за один прогон метлы: каждое — до `REQUEST_TIMEOUT_MS`. */
export const SONIOX_PENDING_DELETE_PER_RUN = 25;
/** Общий срок прогона очереди — метла живёт в одной функции Vercel. */
const PENDING_DRAIN_DEADLINE_MS = 30_000;
/** Повторов записи очереди при гонке (CAS по старому значению). */
const PENDING_CAS_TRIES = 3;

export type SonioxPendingKind = 'transcription' | 'file';

export interface SonioxPendingDelete {
  kind: SonioxPendingKind;
  id: string;
  /** Когда впервые не удалось удалить, ISO. */
  since: string;
  /** Сколько раз метла уже пробовала. */
  attempts: number;
  /** Последний код ответа (0 — сеть). */
  lastStatus?: number;
  /** Когда метла пробовала в последний раз, ISO (нет — ещё не пробовала). */
  lastAttemptAt?: string;
}

export interface SonioxPendingDrainResult {
  /** Удалено (или Soniox ответил 404 — удалять нечего). */
  deleted: number;
  /** Снято с очереди без удаления: попытки или срок вышли. */
  dropped: number;
  /** Осталось в очереди после прогона. */
  left: number;
  /** Ключа Soniox нет — очередь не трогали. */
  skipped?: boolean;
}

type PendingPrisma = Pick<PrismaService, 'platformSetting'>;

const pendingKey = (e: { kind: string; id: string }) => `${e.kind}:${e.id}`;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Путь удаления у Soniox по записи очереди. */
export function sonioxPendingPath(e: SonioxPendingDelete): string {
  return e.kind === 'file' ? `/files/${e.id}` : `/transcriptions/${e.id}`;
}

/**
 * Разбор значения настройки. Мусор (не JSON, не массив, кривые записи)
 * не роняет ни уборку, ни метлу — кривые записи отбрасываются; id
 * проверяется по форме, потому что он уходит в путь запроса.
 */
export function parseSonioxPendingDeletes(
  raw: string | null | undefined,
): SonioxPendingDelete[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: SonioxPendingDelete[] = [];
  const seen = new Set<string>();
  for (const d of data as unknown[]) {
    if (!d || typeof d !== 'object') continue;
    const e = d as Record<string, unknown>;
    if (e.kind !== 'transcription' && e.kind !== 'file') continue;
    if (typeof e.id !== 'string' || !ID_RE.test(e.id)) continue;
    if (typeof e.since !== 'string' || Number.isNaN(Date.parse(e.since)))
      continue;
    const attempts =
      typeof e.attempts === 'number' && Number.isFinite(e.attempts)
        ? Math.max(0, Math.floor(e.attempts))
        : 0;
    const k = pendingKey({ kind: e.kind, id: e.id });
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      kind: e.kind,
      id: e.id,
      since: e.since,
      attempts,
      ...(typeof e.lastStatus === 'number' ? { lastStatus: e.lastStatus } : {}),
      ...(typeof e.lastAttemptAt === 'string' &&
      !Number.isNaN(Date.parse(e.lastAttemptAt))
        ? { lastAttemptAt: e.lastAttemptAt }
        : {}),
    });
  }
  return out;
}

/**
 * Порядок прогона: сначала ни разу не пробованные (по `since`), затем —
 * давнее всего пробованные. Иначе записи, которые не удаляются (Soniox
 * упорно отвечает 409/5xx), навсегда занимали бы голову очереди и
 * `SONIOX_PENDING_DELETE_PER_RUN` мест каждого прогона (аудит захода 8 —
 * тот же приём, что в ночной сверке роликов).
 */
export function sonioxPendingOrder(
  list: readonly SonioxPendingDelete[],
): SonioxPendingDelete[] {
  const at = (e: SonioxPendingDelete) =>
    e.lastAttemptAt ? Date.parse(e.lastAttemptAt) : -Infinity;
  return [...list].sort(
    (a, b) => at(a) - at(b) || Date.parse(a.since) - Date.parse(b.since),
  );
}

/**
 * Добавить в очередь: повтор того же id не дублируется; сверх потолка
 * вытесняются САМЫЕ СТАРЫЕ (возвращаются — их id уходит в лог).
 */
export function addSonioxPendingDelete(
  list: SonioxPendingDelete[],
  entry: SonioxPendingDelete,
  max = SONIOX_PENDING_DELETE_MAX_ENTRIES,
): { list: SonioxPendingDelete[]; evicted: SonioxPendingDelete[] } {
  if (list.some((e) => pendingKey(e) === pendingKey(entry))) {
    return { list, evicted: [] };
  }
  const next = [...list, entry];
  const over = Math.max(next.length - max, 0);
  return { list: next.slice(over), evicted: next.slice(0, over) };
}

/** Удалено или удалять нечего — запись больше не нужна. */
export function sonioxDeleteDone(status: number): boolean {
  return (status >= 200 && status < 300) || status === 404;
}

/**
 * Применить исходы прогона к ТЕКУЩЕЙ очереди (а не к снимку, с которого
 * прогон начался: за время удалений распознавание могло добавить новые
 * записи — их нельзя потерять). Записи без исхода не трогаются.
 */
export function applySonioxDeleteOutcomes(
  list: SonioxPendingDelete[],
  outcomes: ReadonlyMap<string, number>,
  now: Date,
  limits: { maxAttempts: number; maxAgeMs: number } = {
    maxAttempts: SONIOX_PENDING_DELETE_MAX_ATTEMPTS,
    maxAgeMs: SONIOX_PENDING_DELETE_MAX_AGE_MS,
  },
): {
  list: SonioxPendingDelete[];
  deleted: SonioxPendingDelete[];
  dropped: SonioxPendingDelete[];
} {
  const next: SonioxPendingDelete[] = [];
  const deleted: SonioxPendingDelete[] = [];
  const dropped: SonioxPendingDelete[] = [];
  for (const e of list) {
    const status = outcomes.get(pendingKey(e));
    if (status === undefined) {
      next.push(e);
      continue;
    }
    if (sonioxDeleteDone(status)) {
      deleted.push(e);
      continue;
    }
    const tried = {
      ...e,
      attempts: e.attempts + 1,
      lastStatus: status,
      lastAttemptAt: now.toISOString(),
    };
    const age = now.getTime() - Date.parse(e.since);
    if (tried.attempts >= limits.maxAttempts || age >= limits.maxAgeMs) {
      dropped.push(tried);
      continue;
    }
    next.push(tried);
  }
  return { list: next, deleted, dropped };
}

/**
 * Изменить очередь атомарно: чтение → правка → запись только если
 * значение не поменялось с чтения (CAS по `value`), до трёх попыток.
 * `fn` возвращает `null` — менять нечего. Возвращает, удалось ли.
 */
async function mutateSonioxPending(
  prisma: PendingPrisma,
  fn: (list: SonioxPendingDelete[]) => SonioxPendingDelete[] | null,
): Promise<boolean> {
  for (let i = 0; i < PENDING_CAS_TRIES; i++) {
    const row = await prisma.platformSetting.findUnique({
      where: { key: SONIOX_PENDING_DELETE_KEY },
    });
    const next = fn(parseSonioxPendingDeletes(row?.value));
    if (next === null) return true;
    const value = JSON.stringify(next);
    if (!row) {
      try {
        await prisma.platformSetting.create({
          data: { key: SONIOX_PENDING_DELETE_KEY, value },
        });
        return true;
      } catch (e) {
        // Параллельная запись успела создать строку — перечитать.
        if ((e as { code?: string })?.code === 'P2002') continue;
        throw e;
      }
    }
    const r = await prisma.platformSetting.updateMany({
      where: { key: SONIOX_PENDING_DELETE_KEY, value: row.value },
      data: { value },
    });
    if (r.count === 1) return true;
  }
  return false;
}

/**
 * Поставить в очередь то, что не удалилось у Soniox. Не бросает: зовётся
 * из `finally` распознавания. Не вышло записать — id остаётся хотя бы в
 * логе (предупреждение с id), как было до очереди.
 */
export async function enqueueSonioxPendingDelete(
  prisma: PendingPrisma | null | undefined,
  kind: SonioxPendingKind,
  id: string,
  status: number,
  logger: Pick<Logger, 'warn'>,
  now: Date = new Date(),
): Promise<boolean> {
  const what = `${kind === 'file' ? 'файл' : 'транскрипция'} ${id}`;
  if (!prisma || !ID_RE.test(id)) {
    logger.warn(
      `Soniox: ${what} не удалён(а) (${status}) и в очередь не поставлен(а) — удалить вручную`,
    );
    return false;
  }
  let evicted: SonioxPendingDelete[] = [];
  try {
    const ok = await mutateSonioxPending(prisma, (list) => {
      const r = addSonioxPendingDelete(list, {
        kind,
        id,
        since: now.toISOString(),
        attempts: 0,
        lastStatus: status,
      });
      evicted = r.evicted;
      return r.list === list ? null : r.list;
    });
    if (!ok) throw new Error('очередь меняли параллельно трижды подряд');
    for (const e of evicted) {
      logger.warn(
        `Soniox: очередь удаления переполнена — снят(а) ${e.kind} ${e.id} (с ${e.since}), удалить вручную`,
      );
    }
    logger.warn(
      `Soniox: ${what} не удалён(а) (${status}) — поставлен(а) в очередь, повторит метла voice-uploads-sweep`,
    );
    return true;
  } catch (e) {
    logger.warn(
      `Soniox: ${what} не удалён(а) (${status}), очередь недоступна (${e instanceof Error ? e.message : String(e)}) — удалить вручную`,
    );
    return false;
  }
}

/** DELETE у Soniox; отдаёт код ответа (0 — сеть). Ошибки не бросает. */
export async function sonioxDelete(
  key: string,
  path: string,
  logger: Pick<Logger, 'warn'>,
): Promise<number> {
  try {
    const res = await fetch(`${SONIOX_API_BASE}${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 404 && res.status !== 409) {
      logger.warn(`Soniox: уборка ${path} вернула ${res.status}`);
    }
    return res.status;
  } catch (e) {
    logger.warn(
      `Soniox: уборка ${path} не удалась: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 0;
  }
}

/**
 * Повтор удаления по очереди — зовёт метла `voice-uploads-sweep`
 * (`VoiceUploadService.sweepExpired`). Не бросает: очередь — довесок к
 * уборке записей, и её сбой не должен ронять основную метлу.
 *
 * Берёт самые старые записи (не больше `SONIOX_PENDING_DELETE_PER_RUN` и
 * не дольше общего срока), удалено/404 — снимает, остальное — +1 попытка;
 * вышли попытки или срок — снимает с предупреждением и id в логе.
 */
export async function drainSonioxPendingDeletes(
  prisma: PendingPrisma,
  logger: Pick<Logger, 'warn'>,
  now: Date = new Date(),
  opts: { perRun?: number; deadlineMs?: number } = {},
): Promise<SonioxPendingDrainResult> {
  try {
    const row = await prisma.platformSetting.findUnique({
      where: { key: SONIOX_PENDING_DELETE_KEY },
    });
    const snapshot = parseSonioxPendingDeletes(row?.value);
    if (snapshot.length === 0) return { deleted: 0, dropped: 0, left: 0 };
    const key = sonioxApiKey();
    if (!key) {
      logger.warn(
        `Soniox: в очереди удаления ${snapshot.length}, но SONIOX_API_KEY не задан — повтор отложен`,
      );
      return { deleted: 0, dropped: 0, left: snapshot.length, skipped: true };
    }
    const until = Date.now() + (opts.deadlineMs ?? PENDING_DRAIN_DEADLINE_MS);
    const outcomes = new Map<string, number>();
    for (const e of sonioxPendingOrder(snapshot).slice(
      0,
      opts.perRun ?? SONIOX_PENDING_DELETE_PER_RUN,
    )) {
      if (Date.now() >= until) break;
      outcomes.set(
        pendingKey(e),
        await sonioxDelete(key, sonioxPendingPath(e), logger),
      );
    }
    let applied: ReturnType<typeof applySonioxDeleteOutcomes> = {
      list: snapshot,
      deleted: [],
      dropped: [],
    };
    const ok = await mutateSonioxPending(prisma, (list) => {
      applied = applySonioxDeleteOutcomes(list, outcomes, now);
      return applied.list;
    });
    if (!ok) {
      logger.warn(
        'Soniox: очередь удаления меняли параллельно — исходы прогона не записаны, повтор на следующем тике',
      );
      return { deleted: 0, dropped: 0, left: snapshot.length };
    }
    for (const e of applied.dropped) {
      logger.warn(
        `Soniox: ${e.kind} ${e.id} не удалось удалить с ${e.since} (${e.attempts} попыток, последний ответ ${e.lastStatus ?? '—'}) — снят(а) с очереди, удалить вручную`,
      );
    }
    return {
      deleted: applied.deleted.length,
      dropped: applied.dropped.length,
      left: applied.list.length,
    };
  } catch (e) {
    logger.warn(
      `Soniox: прогон очереди удаления не удался: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { deleted: 0, dropped: 0, left: 0 };
  }
}

@Injectable()
export class SonioxSttClient {
  private readonly logger = new Logger(SonioxSttClient.name);
  /** Сроки — полями, чтобы тесты проверяли ветки срока без реального ожидания. */
  attemptDeadlineMs = ATTEMPT_DEADLINE_MS;
  cleanupGraceMs = CLEANUP_GRACE_MS;

  /**
   * База — для очереди неудалённого (C4). Необязательна: без неё (тесты,
   * сборка без Prisma) неудалённое, как прежде, только пишется в лог.
   */
  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly telemetry?: SonioxObservability,
  ) {}

  configured(): boolean {
    return !!sonioxApiKey();
  }

  /**
   * Никогда не бросает — тот же контракт, что у расшифровки через Gemini.
   *
   * ## Бюджет времени (сквозной аудит голоса 29.09.2026)
   *
   * Первая редакция опрашивала 20 раз по секунде, и КАЖДЫЙ запрос мог
   * ждать ответа 15 секунд: худший случай одной попытки — больше пяти
   * минут, а реплика мастера поздравления делает до двух попыток. Теперь
   * у попытки один общий срок (`ATTEMPT_DEADLINE_MS`), и каждый запрос
   * получает не больше, чем от него осталось.
   */
  async transcribe(req: SonioxSttRequest): Promise<SonioxSttResult> {
    return this.telemetry
      ? this.telemetry.track('stt', 'system', () => this.transcribeImpl(req))
      : this.transcribeImpl(req);
  }
  private async transcribeImpl(
    req: SonioxSttRequest,
  ): Promise<SonioxSttResult> {
    const key = sonioxApiKey();
    if (!key)
      return { text: null, reason: 'SONIOX_API_KEY not set', seconds: 0 };
    if (req.audio.length === 0)
      return { text: null, reason: 'empty audio', seconds: 0 };

    const deadline = Date.now() + this.attemptDeadlineMs;
    let fileId: string | null = null;
    let transcriptionId: string | null = null;
    // Длительность звука по данным самого Soniox — по ней он и выставляет
    // счёт. Появляется, когда обработка началась.
    let audioMs: number | null = null;
    try {
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(req.audio)], { type: req.mimeType }),
        // Метка генератора: уборка по списку (`sweepOwnStaleSoniox`)
        // удаляет только своё — ключ может быть общим с другими продуктами.
        sonioxFileName(SONIOX_TAG_GENERATOR),
      );
      form.append(
        'client_reference_id',
        sonioxReferenceId(SONIOX_TAG_GENERATOR),
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
            ...sonioxTranscriptionBody(fileId, req),
            client_reference_id: sonioxReferenceId(SONIOX_TAG_GENERATOR),
          }),
        },
      );
      transcriptionId = created.id;

      const pollDelayMs = process.env.NODE_ENV === 'test' ? 0 : POLL_DELAY_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollDelayMs));
        const status = await this.call<SonioxTranscriptionStatus>(
          key,
          `/transcriptions/${transcriptionId}`,
          deadline,
        );
        if (typeof status.audio_duration_ms === 'number') {
          audioMs = status.audio_duration_ms;
        }
        if (status.status === 'completed') {
          const transcript = await this.call<{
            text?: string;
            tokens?: SonioxToken[];
          }>(key, `/transcriptions/${transcriptionId}/transcript`, deadline);
          const parsed = sonioxTranscriptText(transcript);
          const seconds = billedSeconds(audioMs, parsed.seconds);
          return parsed.text
            ? {
                text: parsed.text,
                seconds,
                language: parsed.language,
                ...(sonioxSpeechConfidence(transcript.tokens ?? []) !== null
                  ? {
                      speechConfidence: sonioxSpeechConfidence(
                        transcript.tokens ?? [],
                      ),
                    }
                  : {}),
                billable: true,
                ...(audioMs !== null ? { audioMs } : {}),
              }
            : {
                text: null,
                reason: 'no speech recognised',
                seconds,
                billable: true,
                ...(audioMs !== null ? { audioMs } : {}),
              };
        }
        if (status.status === 'error') {
          return {
            text: null,
            reason: `Soniox: ${status.error_message ?? 'ошибка распознавания'}`,
            seconds: billedSeconds(audioMs, 0),
            billable: true,
            ...(audioMs !== null ? { audioMs } : {}),
          };
        }
      }
      return {
        text: null,
        reason: 'Soniox: распознавание не уложилось во время',
        seconds: billedSeconds(audioMs, 0),
        billable: true,
        ...(audioMs !== null ? { audioMs } : {}),
      };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.logger.error(`распознавание Soniox не удалось: ${reason}`);
      return {
        text: null,
        reason,
        seconds: billedSeconds(audioMs, 0),
        billable: transcriptionId !== null,
        ...(audioMs !== null ? { audioMs } : {}),
      };
    } finally {
      // Обещание Условий (3.4): запись не остаётся у провайдера.
      await this.cleanup(key, transcriptionId, fileId);
    }
  }

  /**
   * Уборка у Soniox — по его документации, а не наугад (сверено
   * 29.09.2026):
   *
   * - транскрипцию, которая ещё обрабатывается, удалить нельзя — `409`;
   * - файл удалить можно, и задача, которая до него ещё не добралась,
   *   падает с `file_not_found`.
   *
   * Поэтому порядок — СНАЧАЛА ФАЙЛ: аудиозапись, о которой и говорит
   * обещание Условий, уходит от провайдера при любом исходе, включая
   * истёкший срок попытки. Затем транскрипция; на `409` — короткое
   * ожидание конца обработки и ещё одна попытка. Не вышло и после неё
   * (или файл/транскрипцию не удалось удалить по другой причине — сеть,
   * 5xx) — id уходит в очередь `soniox-pending-delete`, и удаление
   * повторит метла `voice-uploads-sweep` (C4 захода 8).
   */
  private async cleanup(
    key: string,
    transcriptionId: string | null,
    fileId: string | null,
  ): Promise<void> {
    if (fileId) {
      const fileStatus = await this.remove(key, `/files/${fileId}`);
      if (!sonioxDeleteDone(fileStatus)) {
        await enqueueSonioxPendingDelete(
          this.prisma,
          'file',
          fileId,
          fileStatus,
          this.logger,
        );
      }
    }
    if (!transcriptionId) return;
    const graceUntil = Date.now() + this.cleanupGraceMs;
    const waitMs = process.env.NODE_ENV === 'test' ? 0 : POLL_DELAY_MS;
    for (;;) {
      const status = await this.remove(
        key,
        `/transcriptions/${transcriptionId}`,
      );
      if (sonioxDeleteDone(status)) return;
      // Не 409 (сеть, 5xx, 401) — ждать конца обработки бессмысленно,
      // а 409 после ожидания — задача всё ещё обрабатывается: в обоих
      // случаях id не теряется, его повторит метла.
      if (status !== 409 || Date.now() >= graceUntil) {
        await enqueueSonioxPendingDelete(
          this.prisma,
          'transcription',
          transcriptionId,
          status,
          this.logger,
        );
        return;
      }
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  /** DELETE; отдаёт код ответа (0 — сеть). Ошибки не бросает. */
  private async remove(key: string, path: string): Promise<number> {
    return sonioxDelete(key, path, this.logger);
  }

  private async call<T>(
    key: string,
    path: string,
    deadline: number,
    init: RequestInit = {},
  ): Promise<T> {
    // Не дольше, чем осталось от срока попытки, и не дольше потолка запроса.
    const left = Math.max(
      1,
      Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()),
    );
    const res = await fetch(`${SONIOX_API_BASE}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(left),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Soniox ${path}: ${res.status} ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }
}
