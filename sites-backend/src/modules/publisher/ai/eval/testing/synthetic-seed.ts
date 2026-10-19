/**
 * AI Publisher — построитель тестовых данных набора 30 задач (P-B2,
 * проектный документ §12.6, §16.0 «построители предметных TD — в
 * `<зона>/testing/`»): синтетика S1–S7 (+ внешний фрагмент AI-25) и
 * «настройки доступа» с канарейкой — ТОЛЬКО в продукт `kind=eval`.
 *
 * Почему здесь, а не через P-B1: синтетика набора — тестовые данные по
 * определению («предназначены исключительно для тестов», AI-eval 2.2),
 * изолированы видом продукта и триггером `pub_synthetic_guard`; сервис
 * источников P-B1 не принимает `isSynthetic` (и не должен). Запись в
 * `pub_sources`/`pub_role_grants` из `testing/` — как у построителей TD
 * других пакетов; CLI `eval:publisher --seed` вызывает её явно (прецедент —
 * `assist-site-chat/eval/run-live.ts` + `testing/chat-stack.testing`).
 * Решение Р-PUB-B2-3 в отчёте пакета; координатор может перенести в P-B1.
 *
 * Идемпотентно: существующие строки (по `externalRef`) не дублируются;
 * существующая строка, расходящаяся с эталоном (аудит S3-10), — ошибка
 * посева, а не тихий пропуск.
 */
import type { SitesDb } from '../../../../../prisma/sites-db.service';
import type { ProductCtx } from '../../../contracts/common';
import { sourceContentHash } from '../../../core/content-hash';
import { injectionFlagOf } from '../../context';
import {
  ACCESS_SETTINGS_FIXTURE,
  EVAL_FIXTURES,
  fixtureMismatches,
  fixtureRef,
} from '../fixtures';
import { auditSourceRef, type AuditSource } from '../tasks-file';

export const SEED_ACTOR = 'system:eval';

export async function seedEvalFixtures(
  db: SitesDb,
  product: Pick<ProductCtx, 'id' | 'accountId' | 'kind'>,
  now = new Date(),
): Promise<{ created: number }> {
  if (product.kind !== 'eval') {
    throw new Error(
      'Синтетика S1–S7 сеется только в продукт kind=eval (§12.6)',
    );
  }
  const t = db.forAccount(product.accountId);
  let created = 0;
  for (const f of EVAL_FIXTURES) {
    const exists = await t.pubSource.findFirst({
      where: { productId: product.id, externalRef: fixtureRef(f.code) },
      select: {
        id: true,
        externalRef: true,
        title: true,
        fragment: true,
        contentHash: true,
        usage: true,
        visibility: true,
      },
    });
    if (exists) {
      if (fixtureMismatches([exists]).length) {
        throw new Error(
          `Синтетика ${f.code} в eval-продукте расходится с эталоном набора 2.2`,
        );
      }
      continue;
    }
    await t.pubSource.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        kind: f.kind,
        externalRef: fixtureRef(f.code),
        title: f.title,
        author: 'Набір AI 2.2 (синтетика)',
        fragment: f.fragment,
        language: 'ru',
        usage: f.usage,
        visibility: f.visibility,
        checkedAt: now,
        freshness: 'current',
        importedVia: 'manual',
        contentHash: sourceContentHash(null, f.fragment),
        injectionFlag: injectionFlagOf(f.fragment),
        isSynthetic: true,
        createdBy: SEED_ACTOR,
      },
    });
    created++;
  }
  const grant = await t.pubRoleGrant.findFirst({
    where: {
      productId: product.id,
      memberId: ACCESS_SETTINGS_FIXTURE.memberId,
    },
    select: { id: true },
  });
  if (!grant) {
    await t.pubRoleGrant.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        memberId: ACCESS_SETTINGS_FIXTURE.memberId,
        memberDisplayName: ACCESS_SETTINGS_FIXTURE.displayName,
        role: ACCESS_SETTINGS_FIXTURE.role,
        grantedBy: SEED_ACTOR,
        createdBy: SEED_ACTOR,
      },
    });
    created++;
  }
  return { created };
}

/**
 * Свои источники ЗАКРЫТОГО набора (`--tasks-file`, Р-IA-FXB-4) —
 * синтетика eval-продукта, как S1–S7: `externalRef` от содержимого
 * (`auditSourceRef`), повторный запуск переиспользует строку. Возвращает
 * id по коду источника набора.
 */
export async function seedAuditSources(
  db: SitesDb,
  product: Pick<ProductCtx, 'id' | 'accountId' | 'kind'>,
  sources: readonly AuditSource[],
  now = new Date(),
): Promise<Record<string, string>> {
  if (product.kind !== 'eval') {
    throw new Error('Источники закрытого набора — только в продукт kind=eval');
  }
  const t = db.forAccount(product.accountId);
  const out: Record<string, string> = {};
  for (const src of sources) {
    const ref = auditSourceRef(src);
    const found = await t.pubSource.findFirst({
      where: { productId: product.id, externalRef: ref, isSynthetic: true },
      select: { id: true },
    });
    if (found) {
      out[src.code] = found.id;
      continue;
    }
    const row = await t.pubSource.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        kind: src.kind,
        externalRef: ref,
        title: src.title,
        author: 'Закритий набір аудиту (синтетика)',
        fragment: src.fragment,
        language: 'uk',
        usage: src.usage,
        visibility: src.visibility,
        checkedAt: now,
        freshness: 'current',
        importedVia: 'manual',
        contentHash: sourceContentHash(null, src.fragment),
        injectionFlag: injectionFlagOf(src.fragment),
        isSynthetic: true,
        createdBy: SEED_ACTOR,
      },
      select: { id: true },
    });
    out[src.code] = row.id;
  }
  return out;
}
