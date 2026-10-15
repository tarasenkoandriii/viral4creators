/**
 * P-R-ADM — db-проверки миграции `20261023090000_publisher_admin_actor`
 * (Р-RD-ADM-2): формат актора `admin:<userId>` (функции `pub_is_actor`,
 * `pub_is_admin`, `pub_is_person` = регулярки `contracts/common.ts`), и
 * закрытый список мест «решает/проверяет человек», где admin допустим:
 * решения параметров, проверка правил, QA editorial/technical ТОЛЬКО
 * Reddit-версии, вызов AI ТОЛЬКО `pub.reddit.draft`; прочие места
 * (факты, утверждение оффера, adaptation_meaning) — по-прежнему `member:`.
 * Всё — 23514 мимо сервисов.
 */
import { randomUUID } from 'crypto';
import { seedApprovedArticle } from '../../ai/testing/ai-kit.testing';
import { ciDescribe } from '../../../../prisma/ci-describe.testing';
import {
  ACTOR_RE,
  ADMIN_ACTOR_RE,
  PERSON_ACTOR_RE,
} from '../../contracts/common';
import {
  api,
  draftVersion,
  redditStack,
  redditWorld,
  seedOffer,
  seedStudio,
  submitVersion,
  type RedditStack,
  type RedditWorld,
} from '../testing/reddit-kit.testing';

jest.setTimeout(180_000);

const CHK = /23514|pub_/;
const ADM = 'admin:clOperatorDb01';

ciDescribe('P-R-ADM db: актор admin:<userId>', () => {
  let s: RedditStack;
  let w: RedditWorld;
  beforeAll(async () => {
    s = await redditStack();
    w = await redditWorld(s);
  });
  afterAll(async () => {
    await s?.close();
  });
  const base = () => ({ accountId: w.acc.accountId, productId: w.product.id });

  it('pub_is_actor / pub_is_admin / pub_is_person = ACTOR_RE / ADMIN_ACTOR_RE / PERSON_ACTOR_RE (вектора)', async () => {
    const vectors = [
      'admin:a',
      `admin:${'x'.repeat(58)}`,
      `admin:${'x'.repeat(59)}`,
      'admin:',
      'admin:a:b',
      'admin:a b',
      'Admin:a',
      'member:abc',
      `member:${'y'.repeat(64)}`,
      'system:reddit-policy',
      'public',
      'restore:r1',
      'ai:x',
      'admin:ä',
    ];
    for (const v of vectors) {
      const [r] = await s.prisma.$queryRaw<
        Array<{ actor: boolean; admin: boolean; person: boolean }>
      >`SELECT "sites"."pub_is_actor"(${v}) AS actor, "sites"."pub_is_admin"(${v}) AS admin,
               "sites"."pub_is_person"(${v}) AS person`;
      expect({ v, ...r }).toEqual({
        v,
        actor: ACTOR_RE.test(v),
        admin: ADMIN_ACTOR_RE.test(v),
        person: PERSON_ACTOR_RE.test(v),
      });
    }
  });

  it('createdBy любой таблицы: admin:<≤58> — да, длиннее — 23514', async () => {
    const mk = (createdBy: string) =>
      s.prisma.pubRedditProject.create({
        data: {
          ...base(),
          name: `adm ${randomUUID().slice(0, 6)}`,
          locale: 'en',
          market: 'US',
          createdBy,
        } as never,
      });
    await expect(mk(ADM)).resolves.toMatchObject({ createdBy: ADM });
    await expect(mk(`admin:${'x'.repeat(59)}`)).rejects.toThrow(
      /актёр не member:\/admin:/,
    );
  });

  it('QA: editorial/technical от admin — только версия Reddit-материала; adaptation_meaning — только member:', async () => {
    const ed = api(s, w.acc.accountId, w.team.editor);
    const po = api(s, w.acc.accountId, w.team.product_owner);
    const ids = await seedStudio(s, w, ed, po);
    const v = await submitVersion(
      ed,
      w,
      ids.contentId,
      await draftVersion(ed, w, ids),
    );
    const qa = (versionId: string, over: Record<string, unknown> = {}) =>
      s.prisma.pubQaCheck.create({
        data: {
          ...base(),
          versionId,
          kind: 'editorial',
          result: 'pass',
          blockers: [],
          warnings: [],
          checkedBy: ADM,
          createdBy: ADM,
          ...over,
        } as never,
      });
    await expect(qa(v.id)).resolves.toMatchObject({ checkedBy: ADM });
    await expect(qa(v.id, { kind: 'technical' })).resolves.toMatchObject({
      kind: 'technical',
    });
    const src = await s.prisma.pubSource.findFirstOrThrow({
      where: { productId: w.product.id, origin: 'content' },
    });
    const art = await seedApprovedArticle(
      s.prisma,
      { id: w.product.id, accountId: w.acc.accountId },
      [src.id],
      w.team.editor.memberId,
    );
    await expect(qa(art.versionId)).rejects.toThrow(
      /admin: — только Reddit-материал/,
    );
    await expect(
      qa(art.versionId, { kind: 'adaptation_meaning' }),
    ).rejects.toThrow(CHK);
    // Участник кабинета — как раньше, на любой версии.
    await expect(
      qa(art.versionId, {
        checkedBy: `member:${w.team.editor.memberId}`,
        createdBy: `member:${w.team.editor.memberId}`,
      }),
    ).resolves.toBeTruthy();
  });

  it('вызов AI от admin — только pub.reddit.draft', async () => {
    const call = async (generator: string) => {
      const task = await s.prisma.pubAiTask.create({
        data: {
          ...base(),
          generator,
          objectType: 'product',
          objectId: `${w.product.id}-${randomUUID().slice(0, 4)}`,
          generationsUsed: 1,
          createdBy: ADM,
        },
      });
      return s.prisma.pubAiCall.create({
        data: {
          ...base(),
          taskId: task.id,
          attemptNo: 1,
          generator,
          purpose: 'test',
          instructionVersion: `${generator}@1`,
          contextRulesVersion: 'ctx@1',
          sourceIds: [],
          provider: 'fake',
          model: 'fake',
          opKey: randomUUID(),
          finishedAt: new Date(),
          status: 'ok',
          costStatus: 'unknown',
          requestedBy: ADM,
          createdBy: ADM,
        },
      });
    };
    await expect(call('pub.reddit.draft')).resolves.toMatchObject({
      requestedBy: ADM,
    });
    await expect(call('pub.helper.answer')).rejects.toThrow(
      /admin: \(только pub\.reddit\.draft\)/,
    );
  });

  it('решения параметров, оффер и факты бренда — admin да (v1.2); проверка утверждений (claims.verifiedBy) — только member:', async () => {
    const p = await s.prisma.pubParameter.findFirstOrThrow({
      where: { productId: w.product.id, key: 'reddit_rules_stale_days' },
    });
    await s.prisma.$transaction(async (tx) => {
      await tx.pubParameterDecision.create({
        data: {
          ...base(),
          parameterKey: p.key,
          version: p.version + 1,
          fromStatus: p.status,
          toStatus: 'approved',
          valueSnapshot: p.value as object,
          decidedBy: ADM,
          basis: 'Рішення оператора платформи',
          dependentStages: [],
          createdBy: ADM,
        },
      });
      await tx.pubParameter.update({
        where: { id: p.id },
        data: {
          status: 'approved',
          version: p.version + 1,
          approvedAt: new Date(),
          approvedBy: ADM,
        },
      });
    });
    // v1.2 (Р-RD-ADM-11): оффер и факты бренда утверждает и оператор
    // Админки; посторонний актор — нет.
    const offerId = await seedOffer(s.prisma, w);
    await expect(
      s.prisma.pubOfferVersion.update({
        where: { id: offerId },
        data: { approvedBy: ADM },
      }),
    ).resolves.toMatchObject({ approvedBy: ADM });
    await expect(
      s.prisma.pubOfferVersion.update({
        where: { id: offerId },
        data: { approvedBy: 'system:x' },
      }),
    ).rejects.toThrow(/approvedBy: утверждает человек \(member:\/admin:\)/);
    const fact = await s.prisma.pubBrandFact.create({
      data: {
        ...base(),
        factKey: `adm.${randomUUID().slice(0, 6)}`,
        kind: 'fact',
        version: 1,
        value: { text: 'Факт платформи' },
        status: 'active',
        approvedBy: ADM,
        approvedAt: new Date(),
        createdBy: ADM,
      } as never,
    });
    expect(fact.approvedBy).toBe(ADM);
    await expect(
      s.prisma.pubBrandFact.update({
        where: { id: fact.id },
        data: { approvedBy: 'public' },
      }),
    ).rejects.toThrow(/pub_brand_facts.approvedBy/);
    const after = await s.prisma.pubParameter.findUniqueOrThrow({
      where: { id: p.id },
    });
    expect([after.status, after.approvedBy]).toEqual(['approved', ADM]);
    const claim = await s.prisma.pubClaim.create({
      data: {
        ...base(),
        statement: 'Пілот коштує 10 000 грн',
        type: 'fact',
        risk: 'normal',
        createdBy: ADM,
      },
    });
    await expect(
      s.prisma.pubClaim.update({
        where: { id: claim.id },
        data: { verifiedBy: ADM, verifiedAt: new Date() },
      }),
    ).rejects.toThrow(/verifiedBy: проверяет человек \(member:\)/);
  });
});
