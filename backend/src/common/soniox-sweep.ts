/**
 * Уборка ОСТАВШЕГОСЯ у Soniox по списку провайдера — только своих
 * объектов (C4 захода 8, аудит: ключ Soniox может быть общим с другими
 * продуктами владельца, и чужое трогать нельзя).
 *
 * ## Зачем список, а не только очередь
 *
 * Своего срока хранения у Soniox нет (документация async-API, сверено
 * 2026-10-07: «Files are not deleted automatically»; лимит — 2000
 * транскрипций на аккаунт). Очередь неудалённого (генератор,
 * `soniox-pending-delete`) ловит то, что `finally` распознавания успел
 * заметить; список ловит и то, что не успел: функцию убили до `finally`.
 *
 * ## Чьё — по метке
 *
 * Каждый продукт ставит метку при создании (`sonioxReferenceId`,
 * `sonioxFileName`): у транскрипции — `client_reference_id`
 * (`v4c-gen:stt`, `v4c-sites:stt`, `v4c-sites:admin`), у файла — то же
 * поле и имя файла (`v4c-gen-stt`). Список транскрипций отдаёт
 * `client_reference_id`, список файлов — только `filename` (документация
 * 2026-10-07), поэтому файл считается своим, если его имя или метка с
 * нашим префиксом ЛИБО он привязан (`file_id`) к нашей транскрипции.
 * Всё остальное — чужое: не удаляется, только считается
 * (`sonioxForeignSkipped`). Объекты, созданные до меток, тоже «чужие» —
 * их однократно убирают вручную.
 *
 * Модуль чистый (без Nest и Prisma): его копирует sites-backend
 * (`scripts/sync-sites-shared.mjs`). В лог — только числа и коды, ни
 * id, ни текста провайдера (§6.6 помощника).
 */

import { SONIOX_API_BASE } from './soniox';

/** Метка генератора (backend). */
export const SONIOX_TAG_GENERATOR = 'v4c-gen';
/** Метка конструктора сайтов (sites-backend: «Сайт» и «Админка»). */
export const SONIOX_TAG_SITES = 'v4c-sites';

/** `client_reference_id` объекта: `<метка>:<назначение>`. */
export function sonioxReferenceId(tag: string, purpose = 'stt'): string {
  return `${tag}:${purpose}`;
}

/** Имя загружаемого файла: `<метка>-<назначение>`. */
export function sonioxFileName(tag: string, purpose = 'stt'): string {
  return `${tag}-${purpose}`;
}

/**
 * Старше этого — точно не живая задача: попытка распознавания длится
 * секунды (у генератора — до 20 с, у сайтов — короче).
 */
export const SONIOX_STALE_AFTER_MS = 60 * 60 * 1000;
/** Удалений за прогон (каждое — до `requestTimeoutMs`). */
export const SONIOX_SWEEP_MAX_DELETES = 200;
/** Страниц списка за прогон (по 1000 — максимум API). */
export const SONIOX_SWEEP_MAX_PAGES = 5;
const SWEEP_DEADLINE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface SonioxSweepResult {
  /** Удалено (или 404 — удалять уже нечего). */
  sonioxFilesDeleted: number;
  sonioxTranscriptionsDeleted: number;
  /** 409 — ещё обрабатывается, будет следующий прогон. */
  sonioxBusy: number;
  /** Сбой удаления или списка — следующий прогон. */
  sonioxFailed: number;
  /** Старые объекты без нашей метки — не тронуты. */
  sonioxForeignSkipped: number;
  /** Ключа нет — к Soniox не ходили. */
  sonioxSkipped?: true;
}

export interface SonioxSweepOptions {
  /** Метка продукта: удаляется только своё. */
  tag: string;
  key: string | null | undefined;
  fetch?: typeof fetch;
  now?: Date;
  logger?: { warn(message: string): unknown };
  staleAfterMs?: number;
  maxDeletes?: number;
  deadlineMs?: number;
}

interface Listed {
  id?: unknown;
  created_at?: unknown;
  client_reference_id?: unknown;
  filename?: unknown;
  file_id?: unknown;
}

function emptyResult(): SonioxSweepResult {
  return {
    sonioxFilesDeleted: 0,
    sonioxTranscriptionsDeleted: 0,
    sonioxBusy: 0,
    sonioxFailed: 0,
    sonioxForeignSkipped: 0,
  };
}

const startsWith = (v: unknown, prefix: string): boolean =>
  typeof v === 'string' && v.startsWith(prefix);

/**
 * Удалить у Soniox СВОИ файлы и транскрипции старше
 * `SONIOX_STALE_AFTER_MS`. Сначала файлы (звук), затем транскрипции.
 * Никогда не бросает.
 */
export async function sweepOwnStaleSoniox(
  opts: SonioxSweepOptions,
): Promise<SonioxSweepResult> {
  const r = emptyResult();
  if (!opts.key) return { ...r, sonioxSkipped: true };
  const doFetch: typeof fetch = opts.fetch ?? ((...a) => fetch(...a));
  const auth = { Authorization: `Bearer ${opts.key}` };
  const cutoff =
    (opts.now ?? new Date()).getTime() -
    (opts.staleAfterMs ?? SONIOX_STALE_AFTER_MS);
  const until = Date.now() + (opts.deadlineMs ?? SWEEP_DEADLINE_MS);
  const refPrefix = `${opts.tag}:`;
  const namePrefix = `${opts.tag}-`;

  const list = async (kind: 'files' | 'transcriptions'): Promise<Listed[]> => {
    const out: Listed[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < SONIOX_SWEEP_MAX_PAGES; page++) {
      if (Date.now() >= until) break;
      const qs = new URLSearchParams({ limit: '1000' });
      if (cursor) qs.set('cursor', cursor);
      try {
        const res = await doFetch(`${SONIOX_API_BASE}/${kind}?${qs}`, {
          headers: auth,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
          opts.logger?.warn(`Soniox: список ${kind} вернул ${res.status}`);
          r.sonioxFailed++;
          break;
        }
        const body = (await res.json()) as Record<string, unknown>;
        if (Array.isArray(body[kind])) out.push(...(body[kind] as Listed[]));
        cursor =
          typeof body.next_page_cursor === 'string' && body.next_page_cursor
            ? body.next_page_cursor
            : null;
        if (!cursor) break;
      } catch (e) {
        opts.logger?.warn(
          `Soniox: список ${kind} не получен: ${e instanceof Error ? e.name : typeof e}`,
        );
        r.sonioxFailed++;
        break;
      }
    }
    return out;
  };

  const stale = (it: Listed): it is Listed & { id: string } => {
    const at =
      typeof it.created_at === 'string' ? Date.parse(it.created_at) : NaN;
    return (
      typeof it.id === 'string' &&
      ID_RE.test(it.id) &&
      Number.isFinite(at) &&
      at < cutoff
    );
  };

  // Сначала транскрипции: по ним узнаём свои файлы (`file_id`).
  const transcriptions = await list('transcriptions');
  const ownFileIds = new Set<string>();
  const ownTranscriptions: string[] = [];
  for (const t of transcriptions) {
    const own = startsWith(t.client_reference_id, refPrefix);
    if (own && typeof t.file_id === 'string') ownFileIds.add(t.file_id);
    if (!stale(t)) continue;
    if (own) ownTranscriptions.push(t.id);
    else r.sonioxForeignSkipped++;
  }
  const ownFiles: string[] = [];
  for (const f of await list('files')) {
    if (!stale(f)) continue;
    const own =
      startsWith(f.filename, namePrefix) ||
      startsWith(f.client_reference_id, refPrefix) ||
      ownFileIds.has(f.id);
    if (own) ownFiles.push(f.id);
    else r.sonioxForeignSkipped++;
  }

  let budget = opts.maxDeletes ?? SONIOX_SWEEP_MAX_DELETES;
  const remove = async (path: string): Promise<number> => {
    try {
      const res = await doFetch(`${SONIOX_API_BASE}${path}`, {
        method: 'DELETE',
        headers: auth,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return res.status;
    } catch {
      return 0;
    }
  };
  const batches: Array<['files' | 'transcriptions', string[]]> = [
    ['files', ownFiles],
    ['transcriptions', ownTranscriptions],
  ];
  for (const [kind, ids] of batches) {
    for (const id of ids) {
      if (budget <= 0 || Date.now() >= until) break;
      budget--;
      const status = await remove(`/${kind}/${id}`);
      if ((status >= 200 && status < 300) || status === 404) {
        if (kind === 'files') r.sonioxFilesDeleted++;
        else r.sonioxTranscriptionsDeleted++;
      } else if (status === 409) {
        r.sonioxBusy++;
      } else {
        r.sonioxFailed++;
      }
    }
  }
  const touched =
    r.sonioxFilesDeleted +
    r.sonioxTranscriptionsDeleted +
    r.sonioxBusy +
    r.sonioxFailed;
  if (touched > 0) {
    opts.logger?.warn(
      `Soniox (${opts.tag}): уборка старше часа — файлов ${r.sonioxFilesDeleted}, транскрипций ${r.sonioxTranscriptionsDeleted}, обрабатывается ${r.sonioxBusy}, сбоев ${r.sonioxFailed}, чужих пропущено ${r.sonioxForeignSkipped}`,
    );
  }
  return r;
}
