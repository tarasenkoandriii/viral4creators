/**
 * AI Publisher, P-B1 — построители предметных данных (проектный документ
 * §16.3, план внешнего аудита):
 *  - TD-03 бренд: активный оффер, неактивная (прежняя) цена, конфликт,
 *    запрещённое обещание, неутверждённый кейс, источники разных разрешений;
 *  - TD-04 исследование: 10 вопросов, 6 тем и 6 готовых брифов, источники
 *    разных разрешений, отозванный источник, claims с поддерживающим и
 *    неподдерживающим доказательством;
 *  - TD-05 материалы: опубликованный согласованный материал, изменённый
 *    черновик новой версии, адаптация прежней версии, исторический кейс.
 * Всё — через сервисы P-B1 и настоящий `runOperation`.
 */
import { randomUUID } from 'crypto';
import type {
  BrandFactView,
  BriefView,
  ClaimView,
  ContentView,
  OfferVersionView,
  QuestionView,
  SourceView,
  VersionView,
} from '../../contracts/content-api';
import { factView } from '../views';
import {
  approvedArticle,
  type ApprovedArticle,
  type Kit,
} from './content-kit.testing';
import { testSlug } from '../../testing/fixtures.testing';

export interface Td03 {
  allowedPublic: SourceView;
  allowedPrivate: SourceView;
  restricted: SourceView;
  revoked: SourceView;
  priceV1: BrandFactView;
  priceV2: BrandFactView;
  priceConflict: BrandFactView;
  condition: BrandFactView;
  forbidden: BrandFactView;
  caseDraft: BrandFactView;
  offerV1: OfferVersionView;
  offerV2: OfferVersionView;
}

export async function td03Brand(k: Kit): Promise<Td03> {
  const allowedPublic = await k.source({ title: 'Публічне дозволене' });
  const allowedPrivate = await k.source({
    title: 'Закрите дозволене',
    visibility: 'private',
  });
  const restricted = await k.source({ title: 'Обмежене', usage: 'restricted' });
  const rv = await k.source({ title: 'Буде відкликане' });
  const revoked = (
    await k.op('source.manage', (tx, st) =>
      k.revocation.revoke(
        tx,
        k.p,
        rv.id,
        { reason: 'Автор відкликав дозвіл' },
        st.actor,
        st.now,
      ),
    )
  ).source;
  const price1 = await k.fact({
    factKey: 'price.service',
    kind: 'price',
    value: { amountMinor: 1_000_000, currency: 'UAH', note: 'пілот' },
    sourceId: allowedPublic.id,
  });
  await k.activateFact(price1.fact.id);
  const condition = await k.fact({
    factKey: 'condition.payment',
    kind: 'condition',
    value: { text: 'Оплата 50/50' },
  });
  await k.activateFact(condition.fact.id);
  const forbidden = await k.fact({
    factKey: 'forbidden.traffic',
    kind: 'forbidden_promise',
    value: { text: 'Гарантія конкретного трафіку' },
  });
  await k.activateFact(forbidden.fact.id);
  const offerV1 = await k.offer({
    priceNote: '10 000 грн',
    factIds: [price1.fact.id],
  });
  // Новая цена: второе значение ключа → needs_resolution → решение PO.
  const price2 = await k.fact({
    factKey: 'price.service',
    kind: 'price',
    value: { amountMinor: 1_200_000, currency: 'UAH', note: 'пілот' },
  });
  await k.op('brand.activate', (tx, st) =>
    k.brand.resolveFact(
      tx,
      k.p,
      price2.fact.id,
      { keepId: price2.fact.id, reason: 'Нова ціна затверджена' },
      st.actor,
      st.now,
    ),
  );
  const offerV2 = await k.offer({
    title: 'Оффер v2',
    priceNote: '12 000 грн',
    factIds: [price2.fact.id],
  });
  const caseDraft = await k.fact({
    factKey: 'case.client-a',
    kind: 'case',
    value: { text: 'Кейс без дозволу клієнта' },
  });
  const conflict = await k.fact({
    factKey: 'price.service',
    kind: 'price',
    value: { amountMinor: 900_000, currency: 'UAH', note: 'знижка' },
  });
  const get = (id: string) =>
    k.tx(async (tx) =>
      factView(await tx.pubBrandFact.findUniqueOrThrow({ where: { id } })),
    );
  return {
    allowedPublic,
    allowedPrivate,
    restricted,
    revoked,
    priceV1: await get(price1.fact.id),
    priceV2: await get(price2.fact.id),
    priceConflict: conflict.fact,
    condition: await get(condition.fact.id),
    forbidden: await get(forbidden.fact.id),
    caseDraft: caseDraft.fact,
    offerV1,
    offerV2,
  };
}

export interface Td04 {
  allowed: SourceView;
  restricted: SourceView;
  revoked: SourceView;
  questions: QuestionView[];
  selected: QuestionView[];
  briefs: BriefView[];
  offer: OfferVersionView;
  claimSupported: ClaimView;
  claimUnsupported: ClaimView;
}

export async function td04Research(k: Kit): Promise<Td04> {
  const offer = await k.offer();
  const allowed = await k.source({ kind: 'customer_question' });
  const restricted = await k.source({
    kind: 'discussion',
    usage: 'restricted',
  });
  const rv = await k.source({ kind: 'interview' });
  const questions: QuestionView[] = [];
  for (let i = 0; i < 10; i++) {
    questions.push(
      await k.question({
        text: `Питання ${i} ${randomUUID().slice(0, 4)}`,
        sources: [
          {
            sourceId: [allowed.id, restricted.id, rv.id][i % 3],
            fragment: `Фрагмент ${i}`,
          },
        ],
      }),
    );
  }
  const revoked = (
    await k.op('source.manage', (tx, st) =>
      k.revocation.revoke(
        tx,
        k.p,
        rv.id,
        { reason: 'Респондент відкликав згоду' },
        st.actor,
        st.now,
      ),
    )
  ).source;
  const selected: QuestionView[] = [];
  const briefs: BriefView[] = [];
  for (let i = 0; i < 6; i++) {
    const cur = await k.tx((tx) =>
      tx.pubQuestion.findUniqueOrThrow({ where: { id: questions[i].id } }),
    );
    const q = await k.selectQuestion(
      { ...questions[i], revision: cur.revision },
      i + 1,
      allowed.id,
    );
    selected.push(q);
    const b = await k.brief({
      questionId: q.id,
      goal: `Відповісти на питання ${i}`,
      format: (['instruction', 'case_review', 'choice_guide'] as const)[i % 3],
      ownContribution: 'Власні дані пілоту',
      cta: 'Обговорити задачу',
      ctaIntentNote: 'Після корисної відповіді — доречно',
      sourceIds: [allowed.id],
    });
    briefs.push(await k.briefReady(b));
  }
  let claimSupported = await k.claim({
    statement: 'Пілот коштує 10 000 грн',
    type: 'fact',
    risk: 'critical',
  });
  claimSupported = await k.claimSource(claimSupported.id, allowed.id, 'yes');
  claimSupported = await k.verify(claimSupported, 'supported');
  let claimUnsupported = await k.claim({
    statement: 'Трафік зросте у 3 рази',
    type: 'estimate',
    risk: 'critical',
  });
  claimUnsupported = await k.claimSource(claimUnsupported.id, allowed.id, 'no');
  return {
    allowed,
    restricted,
    revoked,
    questions,
    selected,
    briefs,
    offer,
    claimSupported,
    claimUnsupported,
  };
}

export interface Td05 {
  article: ApprovedArticle;
  slug: string;
  /** Адаптация (пост) прежней опубликованной версии статьи. */
  adaptation: ContentView;
  adaptationVersion: VersionView;
  /** Изменённый черновик новой версии статьи. */
  draft: VersionView;
  /** Исторический кейс, на который опирается опубликованная версия. */
  historicalCase: BrandFactView;
}

/** TD-05 (продукт `kind=working, mode=live`). */
export async function td05Materials(k: Kit): Promise<Td05> {
  const caseFact = await k.fact({
    factKey: 'case.pilot-1',
    kind: 'case',
    value: { text: 'Кейс пілоту 2025' },
  });
  await k.activateFact(caseFact.fact.id);
  const slug = testSlug('td5');
  const article = await approvedArticle(k, { slug, factId: caseFact.fact.id });
  await k.transition(article.content, 'scheduled');
  await k.publish(article.version.id, 'live', slug);
  // Адаптация опубликованной версии v1.
  const adaptation = await k.content({
    kind: 'post',
    parentContentId: article.content.id,
  });
  let av = await k.version(adaptation.id, {
    title: 'Пост: як обрати агенцію',
    body: 'Короткий пост з головною думкою.',
    meta: { cta: 'Читати статтю' },
    claimIds: [article.claim.id],
    sourceIds: [article.source.id],
    offerVersionId: article.offerId,
    parentVersionId: article.version.id,
  });
  av = await k.submit(av);
  await k.qaPass(av.id, 'editorial');
  await k.qaPass(av.id, 'technical');
  await k.qaPass(av.id, 'adaptation_meaning');
  await k.approve(av);
  // Изменённый черновик статьи: needs_correction → новая версия (черновик).
  let c = await k.getContent(article.content.id);
  c = await k.transition(c, 'correction_required', {
    reason: 'Оновити приклад',
  });
  const draft = await k.version(c.id, {
    title: 'Як обрати агенцію (v2)',
    body: 'Оновлений текст.',
    meta: { cta: 'Обговорити задачу' },
    sourceIds: [article.source.id],
    claimIds: [article.claim.id],
    offerVersionId: article.offerId,
  });
  return {
    article,
    slug,
    adaptation: await k.getContent(adaptation.id),
    adaptationVersion: await k.getVersion(av.id),
    draft,
    historicalCase: caseFact.fact,
  };
}
