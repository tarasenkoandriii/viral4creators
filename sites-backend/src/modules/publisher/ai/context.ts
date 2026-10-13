/**
 * AI Publisher — контекст AI-вызова, правила `ctx@1` (P-B2, проектный
 * документ §12.3; AT-CORE-09 AI-часть, AT-CORE-21).
 *
 * Входит ТОЛЬКО:
 *  - источники `usage=allowed` (для `public` — ещё `visibility=public`) из
 *    явно переданного списка; без списка (только `helper.answer`) — все
 *    разрешённые для режима, фактический список пишется в вызов;
 *  - активные факты бренда и активная версия оффера; запрещённые обещания
 *    — как ограничения;
 *  - только последняя редакция источника; прежние — никогда (Р-PUB-B1-R4);
 *    отзыв любой строки цепочки редакций исключает всю цепочку (аудит S1-2).
 *
 * Не входит НИКОГДА: заявки и контакты, платежи, бюджеты, параметры
 * доступа, роли, ключи, журнал аудита, `restricted/revoked` источники.
 * Модуль читает ровно три таблицы — `pub_sources`, `pub_brand_facts`,
 * `pub_offer_versions` (тест `ai-context.spec` ищет имена других моделей в
 * `publisher/ai/**`). Выборка — в момент вызова, кэша нет: отозванный
 * источник исключается из НОВОГО контекста немедленно (AT-CORE-21).
 *
 * Фрагмент, похожий на команду, помечается (`injectionFlag`), но не
 * удаляется: он остаётся недоверенными данными (AI-25).
 */
import {
  CONTEXT_RULES_VERSION,
  type AiContext,
  type AiContextSource,
} from '../contracts/ai';
import { PubError, validationError } from '../core/errors';
import type { PubTx } from '../core/ports';
import { injectionFlagOf, sourceInjectionText } from '../content/command-flags';
import { selectContext } from '../content/context-selection';

/** Потолок текста источников в контексте (оценка денег сверху, §12.1). */
export const MAX_CONTEXT_SOURCE_CHARS = 60_000;
/** Потолок числа источников (`pub_ai_calls.sourceIds` ≤ 500 — триггер). */
export const MAX_CONTEXT_SOURCES = 60;

/** Виды фактов бренда, которые видит публичный режим (без кейсов/примеров). */
export const PUBLIC_FACT_KINDS = [
  'fact',
  'price',
  'condition',
  'limitation',
  'forbidden_promise',
  'faq',
  'tone',
] as const;

// Детектор команд издателю — общий с сохранением источника (предаудит
// D1-01): `content/command-flags.ts`; реэкспорт для генераторов и тестов.
export { injectionFlagOf };

export type ContextAudience = 'internal' | 'public';

export interface ContextRequest {
  audience: ContextAudience;
  /** Явный список; `undefined` — все разрешённые (только если `allowAll`). */
  sourceIds?: readonly string[];
  /** Без списка — все разрешённые для режима (helper.answer, аудит P3-14). */
  allowAll?: boolean;
}

export interface BuiltContext {
  ctx: AiContext;
  /** Фактически переданные источники (журнальный снимок вызова). */
  sourceIds: string[];
  /** Факты бренда в контексте — экран предлагает связать с версией (§12.3). */
  factIds: string[];
}

/** Клиент чтения: транзакция или `SitesDb.forAccount(...)`. */
export type ContextDb = Pick<
  PubTx,
  'pubSource' | 'pubBrandFact' | 'pubOfferVersion'
>;

/** Почему явно запрошенный источник не вошёл (409 `PUB_SOURCE_NOT_ALLOWED`). */
export type SourceRejection =
  | 'not_found'
  | 'superseded'
  | 'revoked'
  | 'revoked_in_chain'
  | 'restricted'
  | 'private_for_public';

interface ChainRow {
  id: string;
  supersedesId: string | null;
  usage: string;
  visibility: string;
}

/**
 * Источники, которые МОЖНО передать в контекст (аудит P-B2 S1-2; правила
 * P-B1 `selectContext` + цепочка редакций):
 *  - только последняя редакция (у строки нет наследника `supersedesId`) —
 *    прежние редакции не входят никогда (Р-PUB-B1-R4);
 *  - `usage=allowed` и (для `public`) `visibility=public`;
 *  - ни одна строка ЦЕПОЧКИ редакций (вверх и вниз по `supersedesId`) не
 *    `revoked`: отозванное согласие на текст не обходится новой редакцией.
 * Возвращает допустимые id и причину отказа для остальных.
 */
export async function usableSourceIds(
  db: ContextDb,
  productId: string,
  audience: ContextAudience,
  ids: readonly string[] | null,
): Promise<{ ok: string[]; rejected: Map<string, SourceRejection> }> {
  // Единая выборка с экраном «что увидит AI» (P-B1, Р-PUB-B1-20).
  const preview = await selectContext(db as unknown as PubTx, productId, {
    purpose: 'ai-context',
    audience,
    ...(ids ? { sourceIds: ids } : {}),
  });
  const selected = new Set(preview.sources.map((s) => s.id));
  const rows: ChainRow[] = await db.pubSource.findMany({
    where: { productId },
    select: { id: true, supersedesId: true, usage: true, visibility: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const succ = new Map<string, string[]>();
  for (const r of rows) {
    if (r.supersedesId)
      succ.set(r.supersedesId, [...(succ.get(r.supersedesId) ?? []), r.id]);
  }
  const chainRevoked = (id: string): boolean => {
    const seen = new Set<string>([id]);
    const stack = [id];
    while (stack.length) {
      const cur = byId.get(stack.pop()!);
      if (!cur) continue;
      if (cur.usage === 'revoked') return true;
      for (const n of [cur.supersedesId, ...(succ.get(cur.id) ?? [])]) {
        if (n && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    return false;
  };
  const ok: string[] = [];
  const rejected = new Map<string, SourceRejection>();
  for (const id of ids ?? preview.sources.map((s) => s.id)) {
    const r = byId.get(id);
    if (!r) rejected.set(id, 'not_found');
    else if (r.usage === 'revoked') rejected.set(id, 'revoked');
    else if (chainRevoked(id)) rejected.set(id, 'revoked_in_chain');
    else if ((succ.get(id) ?? []).length) rejected.set(id, 'superseded');
    else if (r.usage !== 'allowed') rejected.set(id, 'restricted');
    else if (audience === 'public' && r.visibility !== 'public') {
      rejected.set(id, 'private_for_public');
    } else if (!selected.has(id)) rejected.set(id, 'restricted');
    else ok.push(id);
  }
  return { ok, rejected };
}

/**
 * Собрать контекст продукта (§12.3). Явный список с недопустимым
 * источником (отозван — сам или в цепочке редакций, прежняя редакция,
 * ограничен, закрыт для `public`, чужой, нет) — 409 `PUB_SOURCE_NOT_ALLOWED
 * {sourceIds, reasons}`: молча выбрасывать запрошенное нельзя.
 */
export async function buildContext(
  db: ContextDb,
  productId: string,
  req: ContextRequest,
): Promise<BuiltContext> {
  const explicit = req.sourceIds !== undefined;
  if (!explicit && !req.allowAll) {
    throw validationError([{ field: 'sourceIds', code: 'required' }]);
  }
  const wanted = explicit ? [...new Set(req.sourceIds)] : null;
  if (wanted && wanted.length > MAX_CONTEXT_SOURCES) {
    throw validationError([{ field: 'sourceIds', code: 'length' }]);
  }
  const usable = await usableSourceIds(db, productId, req.audience, wanted);
  if (wanted && usable.rejected.size) {
    throw new PubError('PUB_SOURCE_NOT_ALLOWED', {
      sourceIds: [...usable.rejected.keys()],
      reasons: Object.fromEntries(usable.rejected),
    });
  }
  const rows = usable.ok.length
    ? await db.pubSource.findMany({
        where: { productId, id: { in: usable.ok }, usage: 'allowed' },
        select: {
          id: true,
          title: true,
          fragment: true,
          visibility: true,
          injectionFlag: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      })
    : [];
  const sources: AiContextSource[] = [];
  let chars = 0;
  // Явный список — в порядке запроса; все разрешённые — новые первыми,
  // пока помещаются в потолок.
  const ordered = wanted
    ? wanted.map((id) => rows.find((r) => r.id === id)).filter((r) => !!r)
    : rows;
  for (const r of ordered) {
    const size = r.fragment.length + (r.title?.length ?? 0);
    if (
      chars + size > MAX_CONTEXT_SOURCE_CHARS ||
      sources.length >= MAX_CONTEXT_SOURCES
    ) {
      if (wanted) {
        throw validationError([
          { field: 'sourceIds', code: 'context_too_large' },
        ]);
      }
      continue;
    }
    chars += size;
    sources.push({
      id: r.id,
      title: r.title,
      fragment: r.fragment,
      visibility: r.visibility === 'public' ? 'public' : 'private',
      // Пустая строка — тоже «не проверено» (аудит S3-7).
      injectionFlag:
        r.injectionFlag ||
        injectionFlagOf(sourceInjectionText(r.title, r.fragment)),
    });
  }
  const facts = await db.pubBrandFact.findMany({
    where: {
      productId,
      status: 'active',
      ...(req.audience === 'public'
        ? { kind: { in: [...PUBLIC_FACT_KINDS] } }
        : {}),
    },
    select: { id: true, factKey: true, kind: true, value: true, version: true },
    orderBy: [{ factKey: 'asc' }, { version: 'desc' }],
  });
  const offer = await db.pubOfferVersion.findFirst({
    where: { productId, status: 'active' },
    select: {
      id: true,
      version: true,
      title: true,
      text: true,
      priceNote: true,
    },
  });
  const ctx: AiContext = {
    rulesVersion: CONTEXT_RULES_VERSION,
    audience: req.audience,
    sources,
    facts: facts.map((f) => ({
      id: f.id,
      factKey: f.factKey,
      kind: f.kind,
      value: f.value,
      version: f.version,
    })),
    offer: offer
      ? {
          id: offer.id,
          version: offer.version,
          title: offer.title,
          text: offer.text,
          priceNote: offer.priceNote,
        }
      : null,
  };
  return {
    ctx,
    sourceIds: sources.map((s) => s.id),
    factIds: facts.map((f) => f.id),
  };
}
