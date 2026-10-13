/**
 * AI Publisher — «параметрная» часть гейтов `public_publish`/`real_leads`
 * в строке продукта (P-A1, проектный документ §6.2, §10; аудит P2-9).
 * Представление `pub_public_products` (SQL, роль `publisher_public`) не
 * может вызвать `evaluateGate`, поэтому флаги `paramsPublicPublishOk` и
 * `paramsRealLeadsOk` пересчитывает ЛЮБАЯ операция над параметрами — этой
 * одной функцией в той же транзакции. Тест сверяет флаги с `evaluateGate`.
 *
 * Флаги производные: ревизия продукта не растёт (Р-PUB-A1-6) — иначе
 * решение по параметру давало бы ложный 409 параллельной правке имени.
 *
 * СЕРИАЛИЗАЦИЯ (аудит P1-1): в READ COMMITTED две параллельные операции
 * над параметрами видели чужой параметр в старом виде, и флаг расходился с
 * `evaluateGate`. Поэтому каждая операция над параметрами и режимом
 * (`propose`, `withdraw`, `decide` — и через порт, `changeMode`,
 * `GatePort.assertOpen`) ПЕРВЫМ делом берёт `lockProduct` — блокировку
 * строки продукта `FOR NO KEY UPDATE` до конца транзакции. Она не мешает
 * вставкам в дочерние таблицы (FK берёт KEY SHARE) и чтению.
 */
import {
  GATE_PARAMETER_KEYS,
  type ParameterKey,
} from '../contracts/parameters';
import { PubError } from './errors';
import { parameterPlaceholderIssues } from './parameter-schemas';
import type { ProductRef, PubTx } from './ports';

/**
 * Блокировка строки продукта до конца транзакции (аудит P1-1). Продукт
 * другого кабинета или удалённый — 404. Повторный вызов в той же
 * транзакции ничего не стоит.
 */
export async function lockProduct(
  tx: PubTx,
  product: ProductRef,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "sites"."pub_products"
     WHERE "id" = ${product.id} AND "accountId" = ${product.accountId}
       FOR NO KEY UPDATE`;
  if (rows.length !== 1) throw new PubError('PUB_NOT_FOUND');
}

export interface GateFlags {
  paramsPublicPublishOk: boolean;
  paramsRealLeadsOk: boolean;
}

/**
 * Флаги по статусам параметров (чистая часть). `placeholders` — ключи,
 * чьё действующее значение — заглушка умолчания (Р-PUB-Z2-26): как
 * `evaluateGate`, такой ключ флаг не открывает.
 */
export function gateFlagsOf(
  statuses: ReadonlyMap<string, string>,
  placeholders: ReadonlySet<string> = new Set(),
): GateFlags {
  const approved = (keys: readonly ParameterKey[]) =>
    keys.every((k) => statuses.get(k) === 'approved' && !placeholders.has(k));
  return {
    paramsPublicPublishOk: approved(GATE_PARAMETER_KEYS.public_publish),
    paramsRealLeadsOk: approved(GATE_PARAMETER_KEYS.real_leads),
  };
}

export async function refreshGateFlags(
  tx: PubTx,
  productId: string,
): Promise<GateFlags> {
  const rows = await tx.pubParameter.findMany({
    where: { productId },
    select: { key: true, status: true, value: true },
  });
  const flags = gateFlagsOf(
    new Map(rows.map((r) => [r.key, r.status])),
    new Set(
      rows
        .filter(
          (r) =>
            parameterPlaceholderIssues(r.key as ParameterKey, r.value).length >
            0,
        )
        .map((r) => r.key),
    ),
  );
  await tx.pubProduct.updateMany({
    where: {
      id: productId,
      OR: [
        { paramsPublicPublishOk: !flags.paramsPublicPublishOk },
        { paramsRealLeadsOk: !flags.paramsRealLeadsOk },
      ],
    },
    data: flags,
  });
  return flags;
}
