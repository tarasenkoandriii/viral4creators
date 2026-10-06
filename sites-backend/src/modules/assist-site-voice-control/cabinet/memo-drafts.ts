/**
 * Пакетное создание черновиков мемо «Сайта» (Э6-тер (к), ТЗ §5-бис.17 п.2,
 * п.6, п.9): из шаблона платформы и из файла карты (импорт). Только
 * черновики — ни один источник не публикует.
 *
 *  - номера `М-N` — из `assist_sites.memoCounter` одним UPDATE на пакет
 *    (не переиспользуются); UPDATE блокирует строку сайта до конца
 *    транзакции, и лимит тарифа считается ПОСЛЕ него — параллельный импорт
 *    и «Новое мемо» не дают 21 из 20 (как `MemoService.insertMemo`, аудит
 *    Э6-бис (е) (4)); сверх лимита — отказ `limit` в отчёте, а не 402 на всё;
 *  - ключ из файла/шаблона — если свободен в сайте (включая удалённые: ключ
 *    занят 180 дней), иначе `<ключ>-2…`; имя, занятое другим мемо сайта (в
 *    языке, нормализованно), — отказ `name_taken`;
 *  - каждое мемо — строка истории (источник `template` | `import`).
 * Основная роль (SitesDb.forAccount — кабинет владельца).
 */
import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { readState } from '../../assist-billing/public/entitlements';
import { MEMO_DECISIONS } from '../../assist-ui-core/decisions';
import {
  MEMO_LANGS,
  MEMO_LIMITS,
  parseMemoContent,
  phraseNorm,
  suggestMemoKey,
  type MemoContent,
} from '../../assist-ui-core/memo';
import type { SitesDb } from '../../../prisma/sites-db.service';
import { voiceControlError } from './voice-control-errors';

type Db = ReturnType<SitesDb['forAccount']>;

export interface MemoDraftItem {
  /** Номер в пакете (индекс файла/шаблона) — для отчёта. */
  index: number;
  key: string | null;
  listed: boolean;
  content: MemoContent;
}

export interface MemoDraftsResult {
  created: Array<{ index: number; number: number; key: string }>;
  rejected: Array<{ index: number; key: string | null; code: string }>;
}

/** Лимит мемо «Сайта» тарифа кабинета (В-71, Р-69). */
export async function memoPlanLimit(
  db: Db,
  accountId: string,
  now: Date,
): Promise<number> {
  const state = await readState(db, accountId, now);
  return state.planId ? (MEMO_DECISIONS.limitByPlan[state.planId] ?? 0) : 0;
}

const nameOf = (c: MemoContent): string | null =>
  MEMO_LANGS.map((l) => c.names[l]).find(Boolean) ?? null;

/** Создать черновики пакетом (лимит — в транзакции). */
export async function insertMemoDrafts(
  db: Db,
  p: {
    accountId: string;
    memberId: string;
    siteId: string;
    origin: 'template' | 'import';
    items: readonly MemoDraftItem[];
    now: Date;
  },
): Promise<MemoDraftsResult> {
  const out: MemoDraftsResult = { created: [], rejected: [] };
  if (!p.items.length) return out;
  const limit = await memoPlanLimit(db, p.accountId, p.now);
  const rows = await db.assistSiteMemo.findMany({
    where: { siteId: p.siteId },
    select: { key: true, status: true, draft: true },
  });
  const busyKeys = new Set(rows.map((r) => r.key));
  // Имена в языке — нормализованно (живые мемо сайта + уже принятые в пакете).
  const names = new Set<string>();
  for (const r of rows)
    if (r.status !== 'removed') {
      const c = parseMemoContent(r.draft).content;
      for (const l of MEMO_LANGS)
        if (c.names[l]) names.add(`${l}:${phraseNorm(c.names[l] as string)}`);
    }
  const todo: Array<MemoDraftItem & { key: string }> = [];
  for (const it of p.items) {
    const mine = MEMO_LANGS.flatMap((l) =>
      it.content.names[l]
        ? [`${l}:${phraseNorm(it.content.names[l] as string)}`]
        : [],
    );
    if (!mine.length) {
      out.rejected.push({ index: it.index, key: it.key, code: 'no_name' });
      continue;
    }
    if (mine.some((n) => names.has(n))) {
      out.rejected.push({ index: it.index, key: it.key, code: 'name_taken' });
      continue;
    }
    let key =
      it.key && MEMO_LIMITS.keyRe.test(it.key)
        ? it.key
        : suggestMemoKey(nameOf(it.content) ?? 'memo');
    if (busyKeys.has(key)) {
      const base = key.slice(0, 36);
      let n = 2;
      while (busyKeys.has(`${base}-${n}`)) n++;
      key = `${base}-${n}`;
    }
    busyKeys.add(key);
    for (const n of mine) names.add(n);
    todo.push({ ...it, key });
  }
  if (!todo.length) return out;
  const created = await db
    .$transaction(async (tx) => {
      // Блокировка строки сайта ДО подсчёта (как insertMemo).
      await tx.assistSite.update({
        where: { siteId: p.siteId },
        data: { memoCounter: { increment: 0 } },
        select: { memoCounter: true },
      });
      const used = await tx.assistSiteMemo.count({
        where: { siteId: p.siteId, status: { not: 'removed' } },
      });
      const room = Math.max(0, limit - used);
      const take = todo.slice(0, room);
      for (const it of todo.slice(room))
        out.rejected.push({ index: it.index, key: it.key, code: 'limit' });
      if (!take.length) return [];
      const site = await tx.assistSite.update({
        where: { siteId: p.siteId },
        data: { memoCounter: { increment: take.length } },
        select: { memoCounter: true },
      });
      const first = site.memoCounter - take.length + 1;
      const made: Array<{ index: number; number: number; key: string }> = [];
      for (const [k, it] of take.entries()) {
        const row = await tx.assistSiteMemo.create({
          data: {
            accountId: p.accountId,
            siteId: p.siteId,
            number: first + k,
            key: it.key,
            status: 'draft',
            draft: it.content as unknown as Prisma.InputJsonValue,
            listed: it.listed && MEMO_DECISIONS.listedByDefault,
            view: it.content.view,
            origin: p.origin,
            createdBy: p.memberId,
            updatedBy: p.memberId,
          },
          select: { id: true, number: true },
        });
        await tx.assistSiteMemoChange.create({
          data: {
            accountId: p.accountId,
            siteId: p.siteId,
            memoId: row.id,
            revision: 0,
            actor: p.memberId,
            source: p.origin,
            op: { op: 'create', origin: p.origin } as Prisma.InputJsonValue,
          },
        });
        made.push({ index: it.index, number: row.number, key: it.key });
      }
      return made;
    })
    .catch((e: unknown) => {
      // Тот же ключ заняли параллельно (проверка ключей — до транзакции):
      // пакет откатан целиком, номера не потрачены.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        throw voiceControlError(
          HttpStatus.CONFLICT,
          'MEMO_CONFLICT',
          'Мемо добавили параллельно — повторите',
        );
      throw e;
    });
  out.created.push(...created);
  out.rejected.sort((a, b) => a.index - b.index);
  return out;
}
