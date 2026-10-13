/**
 * AI Publisher, P-B1 — что входит в AI-контекст продукта (правила `ctx@1`,
 * проектный документ §12.3; F02, AT-F02-01, AT-CORE-21). Используется
 * экраном «что увидит AI» (`GET …/context-preview`) и предлагается шлюзу
 * P-B2 как единая выборка (контракт: `ai/context.ts` берёт те же правила):
 *
 *  - источники только `usage=allowed` (для `public` — ещё `visibility=
 *    public`), из явного списка, если он передан; выборка в момент вызова,
 *    кэша нет — отозванный источник выпадает немедленно; прежние редакции
 *    (есть строка с `supersedesId` на них) — никогда, только последняя
 *    (аудит P-B1 S2-4, как `ai/context.ts` P-B2);
 *  - активные факты бренда (без запрещённых обещаний — они отдельным
 *    списком ограничений) и активная версия оффера; черновики,
 *    `needs_resolution`, `superseded`, `rejected` — никогда.
 *
 * Лиды, платежи, бюджеты, роли и журнал сюда не попадают физически: эта
 * функция их не читает.
 */
import type { ContextPreview } from '../contracts/content-api';
import type { PubTx } from '../core/ports';
import { supersededSourceIds } from './refs';

export interface ContextRequest {
  purpose: string;
  audience: 'internal' | 'public';
  /** Явный список источников; без него — все разрешённые для режима. */
  sourceIds?: readonly string[];
}

export async function selectContext(
  tx: PubTx,
  productId: string,
  req: ContextRequest,
): Promise<ContextPreview> {
  const all = await tx.pubSource.findMany({
    where: {
      productId,
      ...(req.sourceIds ? { id: { in: [...req.sourceIds] } } : {}),
    },
    select: {
      id: true,
      title: true,
      usage: true,
      visibility: true,
      injectionFlag: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const excluded = {
    restricted: 0,
    revoked: 0,
    privateForPublic: 0,
    notRequested: 0,
  };
  const sources: ContextPreview['sources'] = [];
  const old = await supersededSourceIds(tx, productId);
  for (const s of all) {
    if (old.has(s.id)) continue;
    if (s.usage === 'revoked') excluded.revoked++;
    else if (s.usage !== 'allowed') excluded.restricted++;
    else if (req.audience === 'public' && s.visibility !== 'public') {
      excluded.privateForPublic++;
    } else {
      sources.push({
        id: s.id,
        title: s.title,
        visibility: s.visibility as 'public' | 'private',
        injectionFlag: s.injectionFlag,
      });
    }
  }
  if (req.sourceIds) {
    excluded.notRequested = await tx.pubSource.count({
      where: { productId, id: { notIn: [...req.sourceIds] } },
    });
  }
  const facts = await tx.pubBrandFact.findMany({
    where: { productId, status: 'active' },
    select: { id: true, factKey: true, kind: true, version: true, value: true },
    orderBy: [{ factKey: 'asc' }],
  });
  const offer = await tx.pubOfferVersion.findFirst({
    where: { productId, status: 'active' },
    select: { id: true, version: true, title: true, priceNote: true },
  });
  return {
    purpose: req.purpose,
    audience: req.audience,
    sources,
    facts: facts
      .filter((f) => f.kind !== 'forbidden_promise')
      .map((f) => ({
        id: f.id,
        factKey: f.factKey,
        kind: f.kind as ContextPreview['facts'][number]['kind'],
        version: f.version,
        value: f.value,
      })),
    offer: offer ?? null,
    forbiddenPromises: facts
      .filter((f) => f.kind === 'forbidden_promise')
      .map((f) => ({ id: f.id, factKey: f.factKey, value: f.value })),
    excluded,
  };
}
