/**
 * Атомарная запись полей снимка брифа поздравления
 * (`Session.greetingBriefSnapshot`) — TODO C2 захода 8.
 *
 * ## Что было не так
 *
 * Снимок лежит одним ключом в `sessions.data`, а `updateSession` сливает
 * ВЕРХНИЕ ключи: `{ greetingBriefSnapshot: {...snapshot, sticker} }`
 * переписывает снимок целиком. Наклейка, музыка, голос, карточки, сцены,
 * правка брифа и галочка витрины читали снимок, меняли своё поле и писали
 * весь объект обратно — две быстрые правки подряд (наклейка и число сцен
 * из соседних карточек мастера, двойной клик, две вкладки) и одна из них
 * бесследно пропадала: вторая запись возвращала первое поле к значению,
 * которое прочитала до него.
 *
 * ## Как теперь
 *
 * 1. Пишутся только изменённые ключи снимка — точечно, на стороне базы,
 *    одним `UPDATE`: `jsonb_set(data, '{greetingBriefSnapshot}', снимок -
 *    удалённые || изменённые)`. Postgres берёт блокировку строки, и
 *    параллельная запись другого поля видит уже новую версию строки —
 *    обе правки доходят. Тот же приём, что у `updateSession` для верхних
 *    ключей (этап 47), только на уровень глубже.
 * 2. Поле, вычисленное из других полей (наклейка разрешена регистром
 *    повода, «персона в ролике» — из образа и голоса), пишется с CAS:
 *    `expect` — ключи, на которые смотрело решение; запись применяется,
 *    только если в базе они те же, что были прочитаны. Иначе — перечитать
 *    снимок, решить заново (`build`), не больше
 *    `MAX_SNAPSHOT_WRITE_ATTEMPTS` раз, затем 409
 *    `GREETING_EDIT_IN_PROGRESS` — тот же код, что у занятого замка
 *    правки, экран уже умеет его показывать.
 * 3. `expect: 'all'` — запись по снимку целиком (правка брифа и смена
 *    голоса: их решение зависит почти от всего снимка). Пишутся всё равно
 *    только изменённые ключи — так что и наоборот, их запись не затирает
 *    поля, которых они не меняли.
 *
 * Колонки `updatedAt` у `Session` нет (есть `lastActivityAt`, но её
 * трогает любая запись в сессию, включая опрос статуса рендера) — CAS по
 * версии строки давал бы ложные промахи, поэтому версия здесь — значения
 * самих зависимых ключей.
 *
 * Запрос получает один JSON-параметр со всем описанием правки
 * (`set`/`remove`/`expect`/`all`/`data`): имена ключей не склеиваются в
 * SQL, и состав запроса не зависит от правки.
 */

import { ConflictException, NotFoundException } from '@nestjs/common';
import { isDeepStrictEqual } from 'util';
import type { PrismaService } from '../prisma/prisma.service';
import type { LIVE_KEYS } from './session.service';
import type { Session } from './types/session.types';
import type { GreetingBriefSnapshot } from './types/greeting.types';
import { GREETING_ERROR_CODES, greetingError } from './greeting-errors';
import { SESSION_NOT_FOUND } from './user-facing-errors';

/**
 * Горячие ключи сессии (`liveData`, этап 122) — их пишет только
 * `updateSession`, у которого для них своя логика переноса. Копия списка,
 * а не импорт: многие спеки подменяют `session.service` целиком, и
 * помощник не должен падать от этого. Расхождение со списком в
 * `session.service` ловит компилятор (проверка ниже).
 */
const HOT_KEYS = ['generatedVideo', 'relevance'] as const;
type HotKey = (typeof LIVE_KEYS)[number];
const HOT_KEYS_COVER_LIVE_KEYS: [
  Exclude<HotKey, (typeof HOT_KEYS)[number]>,
] extends [never]
  ? [Exclude<(typeof HOT_KEYS)[number], HotKey>] extends [never]
    ? true
    : false
  : false = true;
void HOT_KEYS_COVER_LIVE_KEYS;

/** Сколько раз решение пересчитывается по свежему снимку, прежде чем 409. */
export const MAX_SNAPSHOT_WRITE_ATTEMPTS = 3;

export const GREETING_SNAPSHOT_BUSY_MESSAGE =
  'Эту настройку поздравления только что изменили в другом окне или запросе. ' +
  'Подождите секунду и повторите.';

/** Поля, по которым решает политика регистра (наклейки, сцены, музыка). */
export const GREETING_POLICY_KEYS = [
  'occasion',
  'occasionRegister',
  'tone',
] as const satisfies readonly (keyof GreetingBriefSnapshot)[];

export type GreetingSnapshotKey = keyof GreetingBriefSnapshot;

export interface GreetingSnapshotChange {
  /** Ключи снимка к записи; `undefined` — удалить ключ. */
  set: Partial<GreetingBriefSnapshot>;
  /**
   * От каких ключей ПРОЧИТАННОГО снимка зависит решение: запись
   * применяется, только если в базе они те же. `'all'` — весь снимок.
   */
  expect?: readonly GreetingSnapshotKey[] | 'all';
  /**
   * Другие (не горячие) ключи сессии в том же `UPDATE` — например,
   * перештампованный или стёртый сценарий вместе со сменой брифа.
   * `undefined` — стереть (как у `updateSession`).
   */
  data?: Partial<Omit<Session, 'greetingBriefSnapshot'>>;
}

/** Достаточно `$queryRaw` — в тестах его подменяет фейк. */
export type GreetingSnapshotDb = Pick<PrismaService, '$queryRaw'>;

/** Тело единственного параметра запроса записи. */
export interface GreetingSnapshotWritePayload {
  set: Record<string, unknown>;
  remove: string[];
  expect: Record<string, unknown>;
  all?: GreetingBriefSnapshot;
  data: Record<string, unknown>;
}

/** Метки запросов — по ним фейк в тестах узнаёт, что у него просят. */
export const SNAPSHOT_WRITE_TAG = 'greeting-snapshot:write';
export const SNAPSHOT_READ_TAG = 'greeting-snapshot:read';

/**
 * Разница двух снимков в форме `set`: изменённые ключи — новым значением,
 * исчезнувшие — `undefined` (удалить). Для писателей, которые собирают
 * снимок целиком (правка брифа, смена голоса), — чтобы записать только
 * то, что они на самом деле поменяли.
 */
export function diffGreetingSnapshot(
  before: GreetingBriefSnapshot,
  after: GreetingBriefSnapshot,
): Partial<GreetingBriefSnapshot> {
  const set: Record<string, unknown> = {};
  const a = before as unknown as Record<string, unknown>;
  const b = after as unknown as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    if (b[key] === undefined) {
      if (a[key] !== undefined) set[key] = undefined;
      continue;
    }
    if (!isDeepStrictEqual(a[key], b[key])) set[key] = b[key];
  }
  for (const key of Object.keys(a)) {
    if (!(key in b) && a[key] !== undefined) set[key] = undefined;
  }
  return set as Partial<GreetingBriefSnapshot>;
}

/**
 * Правка → параметр запроса. Чистая функция: вся логика «что пишем и при
 * каком условии» здесь, SQL лишь исполняет её.
 */
export function snapshotWritePayload(
  current: GreetingBriefSnapshot | null,
  change: GreetingSnapshotChange,
): GreetingSnapshotWritePayload {
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  for (const [key, value] of Object.entries(change.set)) {
    if (value === undefined) remove.push(key);
    else set[key] = value;
  }
  const expect: Record<string, unknown> = {};
  let all: GreetingBriefSnapshot | undefined;
  if (change.expect === 'all') {
    if (!current) throw new Error('expect: all требует прочитанный снимок');
    all = current;
  } else if (change.expect?.length) {
    if (!current) throw new Error('expect требует прочитанный снимок');
    const read = current as unknown as Record<string, unknown>;
    // `null` и отсутствие ключа — одно и то же (SQL сравнивает так же).
    for (const key of change.expect) expect[key] = read[key] ?? null;
  }
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(change.data ?? {})) {
    if ((HOT_KEYS as readonly string[]).includes(key)) {
      throw new Error(`горячий ключ не пишется вместе со снимком: ${key}`);
    }
    if (key === 'greetingBriefSnapshot') {
      throw new Error('снимок пишется через set, а не через data');
    }
    // Как у `updateSession`: `undefined` — «стереть», пишется как `null`.
    data[key] = value ?? null;
  }
  return { set, remove, expect, ...(all ? { all } : {}), data };
}

function isNoop(p: GreetingSnapshotWritePayload): boolean {
  return (
    !Object.keys(p.set).length &&
    !p.remove.length &&
    !Object.keys(p.data).length
  );
}

function parseSnapshot(raw: unknown): GreetingBriefSnapshot | null {
  const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as GreetingBriefSnapshot)
    : null;
}

/**
 * Одна условная запись. Снимок после записи — или `null`, если условие
 * (`expect`, сессия-поздравление) не выполнилось и ничего не записано.
 * Пустая правка в базу не ходит и возвращает `current`.
 */
export async function applyGreetingSnapshotChange(
  db: GreetingSnapshotDb,
  sessionId: string,
  current: GreetingBriefSnapshot | null,
  change: GreetingSnapshotChange,
): Promise<GreetingBriefSnapshot | null> {
  const payload = snapshotWritePayload(current, change);
  if (isNoop(payload) && current) return current;
  const json = JSON.stringify(payload);
  // `jsonb_set(..., false)`: снимок обязан уже быть объектом (условие
  // ниже), создавать его здесь незачем — сессия без снимка не поздравление.
  // `NOT EXISTS (... <> ...)` — каждый ключ `expect` равен прочитанному;
  // `COALESCE(..., 'null')` делает отсутствие ключа равным `null`.
  const rows = await db.$queryRaw<Array<{ snapshot: unknown }>>`
    /* greeting-snapshot:write */
    WITH p AS (SELECT ${json}::jsonb AS v)
    UPDATE "sessions" AS s
    SET "data" = jsonb_set(
          s."data" || (p.v -> 'data'),
          '{greetingBriefSnapshot}',
          ((s."data" -> 'greetingBriefSnapshot')
             - ARRAY(SELECT jsonb_array_elements_text(p.v -> 'remove')))
            || (p.v -> 'set'),
          false
        ),
        "lastActivityAt" = NOW()
    FROM p
    WHERE s."id" = ${sessionId}
      AND s."deletedAt" IS NULL
      AND jsonb_typeof(s."data" -> 'greetingBriefSnapshot') = 'object'
      AND (p.v -> 'all' IS NULL
           OR s."data" -> 'greetingBriefSnapshot' = p.v -> 'all')
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_each(p.v -> 'expect') AS e(k, val)
         WHERE COALESCE(s."data" -> 'greetingBriefSnapshot' -> e.k, 'null'::jsonb)
               <> e.val
      )
    RETURNING s."data" -> 'greetingBriefSnapshot' AS "snapshot"
  `;
  return rows.length ? parseSnapshot(rows[0].snapshot) : null;
}

/** Свежий снимок из базы (после промаха CAS). `null` — сессии нет. */
export async function readGreetingSnapshot(
  db: GreetingSnapshotDb,
  sessionId: string,
): Promise<GreetingBriefSnapshot | null> {
  const rows = await db.$queryRaw<Array<{ snapshot: unknown }>>`
    /* greeting-snapshot:read */
    SELECT "data" -> 'greetingBriefSnapshot' AS "snapshot"
      FROM "sessions"
     WHERE "id" = ${sessionId} AND "deletedAt" IS NULL
  `;
  return rows.length ? parseSnapshot(rows[0].snapshot) : null;
}

/** 409 после исчерпанных повторов — существующий код, новых не заводим. */
export function greetingSnapshotBusy(): ConflictException {
  return new ConflictException(
    greetingError(
      GREETING_ERROR_CODES.GREETING_EDIT_IN_PROGRESS,
      GREETING_SNAPSHOT_BUSY_MESSAGE,
    ),
  );
}

/**
 * Прочитал — решил — записал, с повтором при промахе.
 *
 * `first` — снимок, уже прочитанный вызывающим (вместе с проверками
 * сессии: рендер не идёт, это поздравление). `build` решает по снимку,
 * какие ключи писать, и может бросить отказ (политика регистра) — на
 * повторе он решает по свежему снимку, и отказ тогда честный. Возвращает
 * снимок таким, каким он стал в базе.
 */
export async function updateGreetingSnapshot(
  db: GreetingSnapshotDb,
  sessionId: string,
  first: GreetingBriefSnapshot,
  build: (
    current: GreetingBriefSnapshot,
  ) => GreetingSnapshotChange | Promise<GreetingSnapshotChange>,
): Promise<GreetingBriefSnapshot> {
  let current = first;
  for (let attempt = 1; ; attempt++) {
    const change = await build(current);
    const written = await applyGreetingSnapshotChange(
      db,
      sessionId,
      current,
      change,
    );
    if (written) return written;
    if (attempt >= MAX_SNAPSHOT_WRITE_ATTEMPTS) throw greetingSnapshotBusy();
    const fresh = await readGreetingSnapshot(db, sessionId);
    if (!fresh) throw new NotFoundException(SESSION_NOT_FOUND);
    current = fresh;
  }
}
