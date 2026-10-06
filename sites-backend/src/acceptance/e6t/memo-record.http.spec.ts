/**
 * Э6-тер (д) по HTTP: маршруты мемо редактора `/editor/v1/memo/record/:op`
 * и `/editor/v1/memo/:key/try` в приложении Nest с настоящими гвардами
 * (initData TMA, @PublicRoute + сессия редактора) и конвертом ошибок:
 * без заголовка сессии — 401 (initData TMA сессией не является), с сессией —
 * запись → черновик → «Прогнать»; неизвестная операция — 404. Логика —
 * `memo-record.spec.ts` (сервисы напрямую).
 */
import * as request from 'supertest';
import { EDITOR_SESSION_HEADER } from '../../brand';
import { setPlan } from '../../modules/assist-billing/testing/billing-fixtures.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { body as dataOf, errCode, Sh3Stack } from '../sh3/sh3-stack';

jest.setTimeout(300_000);

describeDb(
  'Э6-тер (д) по HTTP: маршруты мемо редактора — настоящие гварды и конверт',
  () => {
    const stack = new Sh3Stack();
    beforeAll(async () => {
      await stack.init();
    });
    afterAll(async () => {
      await stack.close();
    });

    it('без заголовка сессии (и с одним initData TMA) — 401; с сессией — запись, черновик, «Прогнать»; неизвестная операция — 404', async () => {
      const s = await stack.site();
      await setPlan(stack.prisma, s.accountId, 'business');
      const link = await request(stack.srv())
        .post(`/assist/sites/${s.siteId}/voice-map/site/editor-link`)
        .set(stack.as(s.ownerTg))
        .send({ host: s.shopHost, path: '/product/1' })
        .expect(200);
      const token = new URL(dataOf(link).url as string).searchParams.get(
        'v4c_edit',
      )!;
      const origin = `https://${s.shopHost}`;
      const ses = dataOf(
        await request(stack.srv())
          .post('/editor/v1/session')
          .send({ token, parentOrigin: origin })
          .expect(200),
      ).session as string;
      const post = (path: string, payload: unknown, session?: string) => {
        const r = request(stack.srv()).post(path);
        if (session) r.set(EDITOR_SESSION_HEADER, session);
        return r.send(payload as object);
      };
      const start = { path: '/product/1' };
      const noSes = await post('/editor/v1/memo/record/start', start);
      expect(noSes.status).toBe(401);
      expect(errCode(noSes)).toBe('EDITOR_SESSION_EXPIRED');
      const tmaOnly = await request(stack.srv())
        .post('/editor/v1/memo/record/start')
        .set(stack.as(s.ownerTg))
        .send(start);
      expect(tmaOnly.status).toBe(401);
      expect(
        (await post('/editor/v1/memo/kosyk/try', { snapshot: {} })).status,
      ).toBe(401);

      expect(
        dataOf(
          await post('/editor/v1/memo/record/start', start, ses).expect(200),
        ).limit,
      ).toEqual({ used: 0, max: 20 });
      const step = dataOf(
        await post(
          '/editor/v1/memo/record/step',
          {
            path: '/product/1',
            descriptor: {
              tag: 'button',
              role: 'button',
              text: 'В кошик',
              assistId: 'add-to-cart',
              unique: true,
            },
            count: 0,
          },
          ses,
        ).expect(200),
      );
      expect(step).toMatchObject({ kind: 'step', exec: true });
      const saved = dataOf(
        await post(
          '/editor/v1/memo/record/stop',
          {
            name: 'У кошик',
            path: '/product/1',
            steps: [step.step],
            slots: [],
          },
          ses,
        ).expect(200),
      );
      expect(saved).toMatchObject({ number: 1, key: 'u-koshyk' });
      const tried = dataOf(
        await post(
          `/editor/v1/memo/${saved.key}/try`,
          {
            snapshot: {
              url: `${origin}/product/1`,
              title: 'Футболка',
              elements: [
                {
                  ref: 'e1',
                  role: 'button',
                  tag: 'button',
                  text: 'В кошик',
                  assistId: 'add-to-cart',
                },
              ],
            },
          },
          ses,
        ).expect(200),
      );
      expect(tried).toMatchObject({ done: true, stopAt: null, goal: 'ok' });
      expect(
        (await post('/editor/v1/memo/record/publish', {}, ses)).status,
      ).toBe(404);
      const bad = await post('/editor/v1/memo/record/stop', { steps: [] }, ses);
      expect(bad.status).toBe(400);
      expect(errCode(bad)).toBe('EDITOR_MEMO_BAD_REQUEST');
    });
  },
);
