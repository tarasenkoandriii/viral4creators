/**
 * AI Publisher, P-B1 — проверка ссылок тела на объекты продукта: источники,
 * claims, факты, вызов AI. Чужой продукт/кабинет и несуществующий id
 * неразличимы (`PUB_VALIDATION {field, code:'not_found'}` для ссылок тела;
 * объект пути — 404). Составные FK и `pub_same_product` держат то же в
 * базе — здесь понятная ошибка раньше.
 */
import type { GeneratorId } from '../contracts/ai';
import { PubError, validationError } from '../core/errors';
import type { AuditInput, ProductRef, PubPorts, PubTx } from '../core/ports';
import type { Actor } from '../core/state-machines';

export async function assertSourceIds(
  tx: PubTx,
  productId: string,
  ids: readonly string[],
  field = 'sourceIds',
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx.pubSource.findMany({
    where: { productId, id: { in: [...ids] } },
    select: { id: true, usage: true },
  });
  const found = new Map(rows.map((r) => [r.id, r.usage]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    throw validationError(missing.map(() => ({ field, code: 'not_found' })));
  }
  const revoked = ids.filter((id) => found.get(id) === 'revoked');
  if (revoked.length) {
    throw new PubError('PUB_SOURCE_NOT_ALLOWED', {
      sourceIds: revoked,
      reason: 'revoked',
    });
  }
  // Аудит P-B1 S2-4: прежняя редакция (есть строка с `supersedesId` на неё)
  // к новым объектам не привязывается — только последняя.
  const old = await tx.pubSource.findMany({
    where: { productId, supersedesId: { in: [...ids] } },
    select: { supersedesId: true },
  });
  if (old.length) {
    throw validationError(
      old.map(() => ({ field, code: 'source_superseded' })),
    );
  }
}

/**
 * Вся цепочка редакций источника (`supersedesId` вверх и вниз, аудит P-B1
 * S1-1), включая сам `id`. Ветвлений нет (вторая редакция одной строки —
 * 409), но обход терпит и их.
 */
export async function sourceChain(
  tx: PubTx,
  productId: string,
  id: string,
): Promise<string[]> {
  const seen = new Set<string>([id]);
  let frontier = [id];
  while (frontier.length) {
    const rows = await tx.pubSource.findMany({
      where: {
        productId,
        OR: [{ id: { in: frontier } }, { supersedesId: { in: frontier } }],
      },
      select: { id: true, supersedesId: true },
    });
    const next: string[] = [];
    for (const r of rows) {
      for (const x of [r.id, r.supersedesId]) {
        if (x && !seen.has(x)) {
          seen.add(x);
          next.push(x);
        }
      }
    }
    frontier = next;
  }
  return [...seen];
}

/** Id источников продукта, у которых есть более новая редакция. */
export async function supersededSourceIds(
  tx: PubTx,
  productId: string,
): Promise<Set<string>> {
  const rows = await tx.pubSource.findMany({
    where: { productId, supersedesId: { not: null } },
    select: { supersedesId: true },
  });
  return new Set(rows.map((r) => r.supersedesId!));
}

export async function assertClaimIds(
  tx: PubTx,
  productId: string,
  ids: readonly string[],
  field = 'claimIds',
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx.pubClaim.findMany({
    where: { productId, id: { in: [...ids] } },
    select: { id: true, claimSupersedesOf: { select: { id: true } } },
  });
  if (rows.length !== ids.length) {
    throw validationError([{ field, code: 'not_found' }]);
  }
  // Исправленный claim (есть новая строка) не привязывается к новой версии.
  const old = rows.filter((r) => r.claimSupersedesOf.length > 0);
  if (old.length) {
    throw validationError(old.map(() => ({ field, code: 'claim_superseded' })));
  }
}

export async function assertActiveFactIds(
  tx: PubTx,
  productId: string,
  ids: readonly string[],
  field = 'factIds',
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx.pubBrandFact.findMany({
    where: { productId, id: { in: [...ids] } },
    select: { id: true, status: true },
  });
  if (rows.length !== ids.length) {
    throw validationError([{ field, code: 'not_found' }]);
  }
  if (rows.some((r) => r.status !== 'active')) {
    throw validationError([{ field, code: 'fact_not_active' }]);
  }
}

/**
 * Принятие предложения AI (§12.5): вызов этого продукта, завершён `ok`,
 * нужного генератора. Сам AI ничего не записывает — запись делает эта
 * мутация человека со ссылкой `aiCallId`.
 */
export async function assertAiCall(
  tx: PubTx,
  productId: string,
  aiCallId: string | null | undefined,
  generators: readonly GeneratorId[],
): Promise<string | null> {
  if (aiCallId === undefined || aiCallId === null) return null;
  const c = await tx.pubAiCall.findFirst({
    where: { id: aiCallId, productId },
    select: { status: true, generator: true },
  });
  if (
    !c ||
    c.status !== 'ok' ||
    !generators.includes(c.generator as GeneratorId)
  ) {
    throw validationError([{ field: 'aiCallId', code: 'ai_call' }]);
  }
  return aiCallId;
}

/**
 * Принятый результат AI (§7.5 `open → done`, интеграция Z-1, Р-PUB-Z1-4):
 * мутация человека с `aiCallId` закрывает AI-задачу вызова через порт P-B2
 * (`pub_ai_tasks` — таблица P-B2). Повтор/задача не в `open` — без записи.
 * Возвращает аудит перехода для операции вызывающего.
 */
export async function acceptAiCall(
  ports: PubPorts,
  tx: PubTx,
  product: ProductRef,
  aiCallId: string | null,
  actors: Actor[],
): Promise<AuditInput[]> {
  if (!aiCallId) return [];
  const r = await ports.aiTasks().acceptCall(tx, product, aiCallId, {
    actors,
  });
  if (!r.accepted) return [];
  return [
    {
      objectType: 'ai_task',
      objectId: r.taskId,
      action: 'transition',
      fromStatus: r.fromStatus,
      toStatus: 'done',
      meta: { aiCallId },
    },
  ];
}
