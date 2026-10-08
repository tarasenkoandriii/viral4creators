/**
 * Заход 9 (аудит пакета C, P3-6): пустые сутки «Сайта», но у «Админки»
 * есть новости (удержанная версия, мемо «требует проверки») — сводка уходит
 * ТОЛЬКО тем, кто видит раздел «Админка» (владелец кабинета и
 * `assistAdmin: owner`); менеджер «Сайта» и оператор её не получают. Нет
 * новостей и у «Админки» — не шлём никому (как раньше).
 */
import { AdminDigestSource } from '../assist-admin-knowledge/admin-digest';
import {
  AnalyticsStack,
  LogCapture,
} from '../assist-analytics/testing/analytics-stack.testing';
import { describeDb } from '../assist-sandbox/testing/k3-stack.testing';
import type { LearningReadApi } from '../assist-site-learning/learning-read.service';
import { AssistDigestService } from './digest.service';

jest.setTimeout(90_000);

const HOUR = 60 * 60 * 1000;

/** Прошлый вторник 06:30 UTC (не понедельник — сводка, не отчёт недели). */
function pastTuesday(): Date {
  const d = new Date();
  d.setUTCHours(6, 30, 0, 0);
  const back = ((d.getUTCDay() + 6) % 7) + 7;
  return new Date(d.getTime() - back * 24 * HOUR + 24 * HOUR);
}

describeDb(
  'сводка: пустой «Сайт», новости «Админки» — только её владельцам',
  () => {
    const st = new AnalyticsStack();
    const logs = new LogCapture();
    let digest: AssistDigestService;
    const sent: Array<{ chat_id: string; text: string }> = [];
    beforeAll(async () => {
      logs.install();
      await st.init();
      digest = new AssistDigestService(
        st.owner,
        st.sitesDb,
        st.rollup,
        new AdminDigestSource(st.sitesDb),
        st.learning as unknown as LearningReadApi,
      );
      digest.env = st.chat.env;
      digest.fetchImpl = async (_u, init) => {
        sent.push(JSON.parse(init.body));
        return { ok: true, status: 200 };
      };
    });
    afterAll(async () => {
      await st.close();
      jest.restoreAllMocks();
    });

    const tuesday = pastTuesday();

    it('удержанная версия и мемо «требует проверки» «Админки» — владелец и assistAdmin: owner получают, менеджер «Сайта» и оператор — нет', async () => {
      const s = await st.site({ name: 'Тихий магазин' });
      const manager = await st.member(s, 'manager');
      const adminOwner = await st.member(s, 'manager', {
        assistAdmin: 'owner',
      });
      const adminEmployee = await st.member(s, 'operator', {
        assistAdmin: 'employee',
      });
      await st.owner.assistAdminKnowledgeVersion.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          number: 1,
          trigger: 'test',
          status: 'held',
        },
      });
      await st.owner.assistAdminMemo.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          number: 7,
          key: 'quiet-review',
          status: 'needs_review',
          draft: {},
          reviewReason: { code: 'goal_low', step: null, version: 1, at: '' },
          createdBy: 'tg:1',
          updatedBy: 'tg:1',
        },
      });
      sent.length = 0;
      const r = await digest.run(tuesday, { siteIds: [s.siteId] });
      expect(r.sent).toBe(2);
      const to = (tg: bigint) =>
        sent.filter((x) => x.chat_id === tg.toString());
      for (const tg of [s.ownerTelegramId, adminOwner.telegramId]) {
        const t = to(tg)[0]?.text ?? '';
        expect(t).toContain('Раздел «Админка»');
        expect(t).toContain('Удержанных версий базы «Админки»: 1');
        expect(t).toContain(
          'Мемо АМ-7 требует проверки: часто не доходит до цели',
        );
      }
      expect(to(manager.telegramId)).toEqual([]);
      expect(to(adminEmployee.telegramId)).toEqual([]);
    });

    it('новостей нет ни у «Сайта», ни у «Админки» — никому', async () => {
      const s = await st.site({ name: 'Совсем тихий' });
      await st.member(s, 'manager', { assistAdmin: 'owner' });
      sent.length = 0;
      const r = await digest.run(tuesday, { siteIds: [s.siteId] });
      expect(r.sent).toBe(0);
      expect(sent).toEqual([]);
    });
  },
);
