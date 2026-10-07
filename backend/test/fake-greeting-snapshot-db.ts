/**
 * Фейк базы для `greeting-snapshot-write` в юнит-тестах сервисов.
 *
 * Сервисы поздравления тестируются на моке `SessionService`; запись
 * снимка теперь идёт мимо `updateSession` — точечным SQL. Фейк исполняет
 * тот же контракт поверх мока: читает снимок через `getSession`, проверяет
 * условие (`expect`/`all`) так же, как SQL, и пишет результат обратно через
 * `updateSession(id, { greetingBriefSnapshot, ...data })`. Поэтому
 * существующие проверки «что записано в сессию» остаются честными, а
 * сам SQL проверяет `greeting-snapshot-write.pg.spec.ts` на настоящем
 * Postgres.
 *
 * `beforeWrite` — крючок, чтобы вклинить «параллельную» правку между
 * чтением и записью (проверка повтора и 409).
 */

import { isDeepStrictEqual } from 'util';
import type { Session } from '../src/common/types/session.types';
import type { GreetingBriefSnapshot } from '../src/common/types/greeting.types';
import {
  GreetingSnapshotDb,
  GreetingSnapshotWritePayload,
  SNAPSHOT_READ_TAG,
  SNAPSHOT_WRITE_TAG,
} from '../src/common/greeting-snapshot-write';

export interface FakeSessionsForSnapshot {
  getSession(id: string): Promise<Session | null | undefined>;
  updateSession(id: string, patch: Partial<Session>): Promise<unknown>;
}

export interface FakeSnapshotDb extends GreetingSnapshotDb {
  /** Попытки записи — в том числе не применённые (CAS-промах). */
  writes: GreetingSnapshotWritePayload[];
  /** Применённые записи. */
  applied: GreetingSnapshotWritePayload[];
}

const norm = (v: unknown): unknown =>
  v === undefined ? null : (JSON.parse(JSON.stringify(v)) as unknown);

export function fakeSnapshotDb(
  sessions: FakeSessionsForSnapshot,
  opts: {
    beforeWrite?: (attempt: number) => unknown;
    /**
     * Чтение строки мимо мока `getSession` — для спек, которые считают
     * его вызовы или подменяют отдельные ответы (`mockImplementationOnce`).
     */
    peek?: (id: string) => Session | null | undefined;
  } = {},
): FakeSnapshotDb {
  const read = async (id: string) =>
    opts.peek ? opts.peek(id) : sessions.getSession(id);
  const writes: GreetingSnapshotWritePayload[] = [];
  const applied: GreetingSnapshotWritePayload[] = [];
  const $queryRaw = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<Array<{ snapshot: GreetingBriefSnapshot }>> => {
    const sql = strings.join('?');
    if (sql.includes(SNAPSHOT_READ_TAG)) {
      const session = await read(values[0] as string);
      const snap = session?.greetingBriefSnapshot;
      return snap ? [{ snapshot: snap }] : [];
    }
    if (!sql.includes(SNAPSHOT_WRITE_TAG)) {
      throw new Error(`фейк не знает запроса: ${sql.slice(0, 80)}`);
    }
    const payload = JSON.parse(
      values[0] as string,
    ) as GreetingSnapshotWritePayload;
    const sessionId = values[1] as string;
    writes.push(payload);
    await opts.beforeWrite?.(writes.length);
    const session = await read(sessionId);
    const snap = session?.greetingBriefSnapshot as
      | Record<string, unknown>
      | undefined;
    if (!snap || typeof snap !== 'object') return [];
    if (payload.all && !isDeepStrictEqual(norm(snap), norm(payload.all))) {
      return [];
    }
    for (const [key, value] of Object.entries(payload.expect)) {
      if (!isDeepStrictEqual(norm(snap[key]), norm(value))) return [];
    }
    const next: Record<string, unknown> = { ...snap };
    for (const key of payload.remove) delete next[key];
    Object.assign(next, payload.set);
    const data: Record<string, unknown> = {};
    // SQL пишет стирание как `null`, `updateSession` принимает его как
    // `undefined` — в мок отдаём так, как его прежде вызывали сервисы.
    for (const [k, v] of Object.entries(payload.data)) {
      data[k] = v === null ? undefined : v;
    }
    await sessions.updateSession(sessionId, {
      greetingBriefSnapshot: next as unknown as GreetingBriefSnapshot,
      ...data,
    });
    applied.push(payload);
    return [{ snapshot: next as unknown as GreetingBriefSnapshot }];
  };
  return {
    $queryRaw: $queryRaw as unknown as GreetingSnapshotDb['$queryRaw'],
    writes,
    applied,
  };
}
