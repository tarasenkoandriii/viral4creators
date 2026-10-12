/**
 * Приёмка захода 13, пакет Б (Р-З13-Б3) — TMA «Обучение → Голос»: карточки
 * терминов распознавания и «вела не туда» по HTTP (настоящие гварды initData
 * и SiteAccountGuard, Postgres; хвост захода 11):
 *  - права: владелец и `assist: manager` — да; оператор — 403; чужой
 *    кабинет — 404;
 *  - список: термины (≥ 2 посетителей, известное карте — нет), «не туда»
 *    по всем страницам (≥ 2 посетителей; мастер/сухие и планы нескольких
 *    целей — нет), цели для выбора (без «никогда»), ревизия черновика;
 *  - принять термин — `set-terms` черновика (источник `tma`, 409 по
 *    ревизии, неактуальная карточка — 409 `VOICE_MAP_SUGGESTION_GONE`);
 *    «Отменить» — обратные операции тем же `PATCH …/draft`;
 *  - перепривязать — фраза синонимом выбранной цели, со старой снимается
 *    одним пакетом; карточка уходит, «Отменить» её возвращает; та же цель
 *    и цель «никогда» — 400;
 *  - «не предлагать» — общий журнал с панелью редактора;
 *  - журнал карты — без текста фраз посетителей.
 */
import * as request from 'supertest';
import { setPlan } from '../../modules/assist-billing/testing/billing-fixtures.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { defaultPersona } from '../../modules/assist-site-setup/persona';
import { termId } from '../../modules/assist-site-voice-map/editor/editor-assist';
import {
  body as dataOf,
  errCode,
  Sh3Stack,
  type Sh3Site,
} from '../sh3/sh3-stack';

jest.setTimeout(300_000);

const gift = {
  tag: 'button',
  role: 'button',
  text: 'Подарункова упаковка',
  assistId: 'gift-wrap',
  unique: true,
};
const cart = {
  tag: 'button',
  role: 'button',
  text: 'В кошик',
  assistId: 'add-to-cart',
  unique: true,
};

describeDb(
  'Заход 13 (Б): TMA «Обучение → Голос» — карточки подсказок карты',
  () => {
    const st = new Sh3Stack();
    beforeAll(async () => {
      await st.init();
    });
    afterAll(async () => {
      await st.close();
    });

    const base = (s: Sh3Site) => `/assist/sites/${s.siteId}/voice-map/site`;
    const get = (s: Sh3Site, tg: bigint = s.ownerTg) =>
      request(st.srv())
        .get(`${base(s)}/suggestions`)
        .set(st.as(tg));
    const post = (s: Sh3Site, path: string, payload: object, tg = s.ownerTg) =>
      request(st.srv())
        .post(`${base(s)}/suggestions/${path}`)
        .set(st.as(tg))
        .send(payload);
    const draft = async (s: Sh3Site) =>
      dataOf(
        await request(st.srv())
          .get(`${base(s)}/draft`)
          .set(st.as(s.ownerTg))
          .expect(200),
      );
    const patch = (s: Sh3Site, expectedRevision: number, ops: unknown[]) =>
      request(st.srv())
        .patch(`${base(s)}/draft`)
        .set(st.as(s.ownerTg))
        .send({ expectedRevision, ops });

    type Wrong = (
      v: string,
      utterance: string,
      extra?: Record<string, unknown>,
    ) => Promise<void>;
    async function seed(s: Sh3Site, more?: (wrong: Wrong) => Promise<void>) {
      await setPlan(st.prisma, s.accountId, 'business');
      const d = await draft(s);
      await patch(s, d.revision as number, [
        {
          op: 'upsert-target',
          target: {
            key: 'cart',
            scope: 'site',
            descriptor: cart,
            names: { uk: 'В кошик' },
            synonyms: { uk: [{ text: 'доставку' }, { text: 'купити' }] },
          },
        },
        {
          op: 'upsert-target',
          target: {
            key: 'gift',
            scope: 'site',
            descriptor: gift,
            names: { uk: 'Подарунок' },
          },
        },
        {
          op: 'upsert-target',
          target: {
            key: 'danger',
            scope: 'site',
            descriptor: { ...cart, text: 'Видалити', assistId: 'del' },
            denylisted: true,
          },
        },
      ]).expect(200);
      const now = new Date();
      const at = (ms: number) => new Date(now.getTime() - ms);
      const url = `https://${s.shopHost}/product/1`;
      const mkPlan = async (
        visitorId: string,
        utteranceMasked: string,
        extra: Record<string, unknown> = {},
      ) => {
        const conv = await st.prisma.assistSiteConversation.create({
          data: {
            accountId: s.accountId,
            siteId: s.siteId,
            visitorId,
            ipHash: `ip-${visitorId}`,
            parentOrigin: `https://${s.shopHost}`,
            lastMessageAt: now,
          },
        });
        return st.prisma.assistSiteUiPlan.create({
          data: {
            accountId: s.accountId,
            siteId: s.siteId,
            conversationId: conv.id,
            visitorId,
            utteranceMasked,
            source: 'voice',
            lang: 'uk',
            pageUrl: url,
            steps: [],
            status: 'stopped',
            needsConfirm: false,
            confirmBefore: now,
            expiresAt: now,
            ...extra,
          },
        });
      };
      const log = (planId: string, data: Record<string, unknown>) =>
        st.prisma.assistSiteUiActionLog.create({
          data: {
            accountId: s.accountId,
            siteId: s.siteId,
            planId,
            stepIndex: 0,
            action: 'click',
            risk: 'auto',
            result: 'done',
            url,
            ...data,
          },
        });
      const wrong = async (v: string, utterance: string, extra = {}) => {
        const p = await mkPlan(v, utterance, extra);
        await log(p.id, { mapKey: 'cart', createdAt: at(10_000) });
        await log(p.id, {
          action: 'stop',
          reason: 'click',
          stepIndex: 1,
          createdAt: at(8_000),
        });
      };
      // «Доставку» → `cart`, двое остановили сразу — карточка.
      await wrong('w-1', 'відкрий доставку');
      await wrong('w-2', 'відкрий доставку');
      // Один посетитель — ниже порога; сухой прогон мастера — не в счёт.
      await wrong('w-3', 'відкрий оплату');
      await wrong('w-4', 'відкрий оплату', { dryRun: true });
      if (more) await more(wrong);
      await st.prisma.assistSiteSttLowTerm.createMany({
        data: [
          ['ксіомі', 'Ксіомі', 'a'],
          ['ксіомі', 'Ксіомі', 'b'],
          ['подарунок', 'Подарунок', 'a'],
          ['подарунок', 'Подарунок', 'b'],
          ['делівері', 'Делівері', 'a'],
        ].map(([norm, word, h]) => ({
          accountId: s.accountId,
          siteId: s.siteId,
          day: now.toISOString().slice(0, 10),
          norm,
          word,
          visitorHash: h.repeat(32),
          ipHash: `ip-${h}`,
        })),
      });
    }

    it('права и список: владелец/менеджер — карточки, цели без «никогда», ревизия; оператор — 403; чужой кабинет — 404', async () => {
      const s = await st.site();
      await seed(s);
      const v = dataOf(await get(s).expect(200));
      const d = await draft(s);
      expect(v.revision).toBe(d.revision);
      expect(v.days).toBe(7);
      expect(v.terms).toEqual([
        expect.objectContaining({ phrase: 'Ксіомі', visitors: 2 }),
      ]);
      expect(v.wrong).toEqual([
        expect.objectContaining({
          key: 'cart',
          phrase: 'доставку',
          lang: 'uk',
          visitors: 2,
          nameClash: false,
        }),
      ]);
      expect(JSON.stringify(v)).not.toContain('оплат');
      expect(v.targets.map((t: { key: string }) => t.key).sort()).toEqual([
        'cart',
        'gift',
      ]);
      expect(v.termsLeft).toBe(100);
      const r = await get(s);
      expect(r.headers['cache-control']).toContain('no-store');

      const manager = await st.member(s, 'manager', { assist: 'manager' });
      await get(s, manager).expect(200);
      const operator = await st.member(s, 'operator', { assist: 'operator' });
      await get(s, operator).expect(403);
      await post(s, 'mute', { id: v.wrong[0].id }, operator).expect(403);
      const other = await st.site();
      const foreign = await get(s, other.ownerTg);
      expect(foreign.status).toBe(404);
      await post(
        s,
        'term',
        { expectedRevision: v.revision, id: v.terms[0].id },
        other.ownerTg,
      ).expect(404);
    });

    it('термин: 409 по ревизии, неактуальная карточка — 409 GONE, принять — в черновик (журнал без текста); «Отменить» — черновик как был, карточка вернулась', async () => {
      const s = await st.site();
      await seed(s);
      const v = dataOf(await get(s).expect(200));
      const id = v.terms[0].id as string;
      const stale = await post(s, 'term', {
        expectedRevision: v.revision - 1,
        id,
      });
      expect(stale.status).toBe(409);
      expect(errCode(stale)).toBe('VOICE_MAP_CONFLICT');
      const gone = await post(s, 'term', {
        expectedRevision: v.revision,
        id: 'f'.repeat(24),
      });
      expect(gone.status).toBe(409);
      expect(errCode(gone)).toBe('VOICE_MAP_SUGGESTION_GONE');
      const bad = await post(s, 'term', {
        expectedRevision: v.revision,
        id: 'x',
      });
      expect(bad.status).toBe(400);
      expect(errCode(bad)).toBe('VOICE_MAP_INVALID');

      const ok = dataOf(
        await post(s, 'term', { expectedRevision: v.revision, id }).expect(200),
      );
      expect(ok).toEqual({
        revision: v.revision + 1,
        term: 'Ксіомі',
        undo: [{ op: 'set-terms', terms: [] }],
      });
      expect((await draft(s)).content.terms).toEqual(['Ксіомі']);
      const after = dataOf(await get(s).expect(200));
      expect(after.terms).toEqual([]);
      expect(after.termsLeft).toBe(99);
      // Повтор — карточки уже нет.
      expect(
        errCode(await post(s, 'term', { expectedRevision: ok.revision, id })),
      ).toBe('VOICE_MAP_SUGGESTION_GONE');
      const ch = await st.prisma.assistSiteVoiceMapChange.findMany({
        where: { siteId: s.siteId, source: 'tma' },
      });
      expect(ch.map((c) => (c.op as { op: string }).op)).toContain('set-terms');
      expect(JSON.stringify(ch)).not.toContain('Ксіомі');

      // «Отменить» — обратные операции тем же PATCH с новой ревизией.
      await patch(s, ok.revision, ok.undo).expect(200);
      expect((await draft(s)).content.terms).toEqual([]);
      expect(dataOf(await get(s).expect(200)).terms).toHaveLength(1);
      // Карту успели поменять — «Отменить» получает 409, черновик цел.
      const late = await patch(s, ok.revision, ok.undo);
      expect(late.status).toBe(409);
    });

    it('перепривязать: та же цель и «никогда» — 400; к выбранной цели — синоним там, со старой снят; карточка ушла; «Отменить» — всё назад; «не предлагать» — карточки нет', async () => {
      const s = await st.site();
      await seed(s);
      const v = dataOf(await get(s).expect(200));
      const w = v.wrong[0] as { id: string; key: string };
      const same = await post(s, 'rebind', {
        expectedRevision: v.revision,
        id: w.id,
        to: 'cart',
      });
      expect(same.status).toBe(400);
      expect(
        (
          await post(s, 'rebind', {
            expectedRevision: v.revision,
            id: w.id,
            to: 'danger',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(s, 'rebind', {
            expectedRevision: v.revision,
            id: w.id,
            to: 'BAD KEY',
          })
        ).status,
      ).toBe(400);
      const ok = dataOf(
        await post(s, 'rebind', {
          expectedRevision: v.revision,
          id: w.id,
          to: 'gift',
        }).expect(200),
      );
      expect(ok).toMatchObject({
        revision: v.revision + 1,
        key: 'gift',
        from: 'cart',
        phrase: 'доставку',
        lang: 'uk',
        detached: true,
      });
      type Draft = {
        content: {
          targets: Array<{
            key: string;
            synonyms: { uk?: Array<{ text: string }> };
          }>;
        };
      };
      const syn = (c: Record<string, unknown>, key: string) =>
        (
          (c as Draft).content.targets.find((t) => t.key === key)!.synonyms
            .uk ?? []
        ).map((x) => x.text);
      const d1 = await draft(s);
      expect(syn(d1, 'gift')).toEqual(['доставку']);
      expect(syn(d1, 'cart')).toEqual(['купити']);
      expect(dataOf(await get(s).expect(200)).wrong).toEqual([]);
      const ch = await st.prisma.assistSiteVoiceMapChange.findMany({
        where: { siteId: s.siteId, source: 'tma', revision: ok.revision },
      });
      expect(JSON.stringify(ch)).not.toContain('доставку');

      await patch(s, ok.revision, ok.undo).expect(200);
      const d2 = await draft(s);
      expect(syn(d2, 'gift')).toEqual([]);
      expect(syn(d2, 'cart')).toEqual(['доставку', 'купити']);
      const back = dataOf(await get(s).expect(200));
      expect(back.wrong.map((x: { id: string }) => x.id)).toEqual([w.id]);

      // «Не предлагать» — общий журнал с панелью (только id).
      await post(s, 'mute', { id: 'nope' }).expect(400);
      await post(s, 'mute', { id: w.id }).expect(200);
      expect(dataOf(await get(s).expect(200)).wrong).toEqual([]);
      const muteRow = await st.prisma.assistSiteVoiceMapChange.findFirst({
        where: { siteId: s.siteId, source: 'suggestion' },
        orderBy: { createdAt: 'desc' },
      });
      expect(muteRow?.op).toEqual({ op: 'suggestion-mute', id: w.id });
      // Неактуальная карточка — 409 GONE.
      expect(
        errCode(
          await post(s, 'rebind', {
            expectedRevision: back.revision,
            id: w.id,
            to: 'gift',
          }),
        ),
      ).toBe('VOICE_MAP_SUGGESTION_GONE');
    });

    it('раунд исправлений (аудит P3-5): команда `de` — не карточка; без языка — язык персоны (ru); термин одного посетителя по id — 409 GONE', async () => {
      const s = await st.site();
      await seed(s, async (wrong) => {
        await wrong('de-1', 'öffne versand', { lang: 'de' });
        await wrong('de-2', 'öffne versand', { lang: 'de' });
        await wrong('n-1', 'відкрий знижки', { lang: null });
        await wrong('n-2', 'відкрий знижки', { lang: null });
      });
      await st.prisma.assistSite.update({
        where: { siteId: s.siteId },
        data: { personaDraft: defaultPersona('ru') as object },
      });
      const v = dataOf(await get(s).expect(200));
      expect(
        v.wrong.map((w: { phrase: string; lang: string | null }) => [
          w.phrase,
          w.lang,
        ]),
      ).toEqual([
        ['доставку', 'uk'],
        ['знижки', null],
      ]);
      expect(JSON.stringify(v)).not.toContain('versand');
      const w = v.wrong.find((x: { phrase: string }) => x.phrase === 'знижки');
      const r = dataOf(
        await post(s, 'rebind', {
          expectedRevision: v.revision,
          id: w.id,
          to: 'gift',
        }).expect(200),
      );
      expect(r).toMatchObject({ lang: 'ru', detached: false });
      const d = await draft(s);
      const gift = (
        d.content as {
          targets: Array<{
            key: string;
            synonyms: Record<string, Array<{ text: string }>>;
          }>;
        }
      ).targets.find((t) => t.key === 'gift')!;
      expect(gift.synonyms.ru?.map((x) => x.text)).toEqual(['знижки']);
      // Термин одного посетителя (ниже порога) по id — не принять.
      const one = await post(s, 'term', {
        expectedRevision: r.revision,
        id: termId('делівері'),
      });
      expect(one.status).toBe(409);
      expect(errCode(one)).toBe('VOICE_MAP_SUGGESTION_GONE');
      expect((await draft(s)).content.terms).toEqual([]);
    });

    it('раунд исправлений (аудит P3-4): перепривязанная фраза не занимает место свежих — ≤ 5 карточек на цель считаются после отбора', async () => {
      const s = await st.site();
      await seed(s, async (wrong) => {
        // «Подарунок» — имя цели `gift`: уже перепривязано (3 посетителя — первое место).
        for (const v of ['g-1', 'g-2', 'g-3'])
          await wrong(v, 'відкрий подарунок');
        for (const p of ['знижки', 'кошик', 'акції', 'новинки', 'бренди'])
          for (const v of ['1', '2']) await wrong(`${p}-${v}`, `відкрий ${p}`);
      });
      const v = dataOf(await get(s).expect(200));
      const cart = v.wrong.filter((w: { key: string }) => w.key === 'cart');
      // 6 свежих фраз по 2 посетителя → 5 (лимит на цель), «подарунок» — нет.
      expect(cart).toHaveLength(5);
      expect(JSON.stringify(cart)).not.toContain('подарунок');
    });
  },
);
