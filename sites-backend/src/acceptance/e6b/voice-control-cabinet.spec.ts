/**
 * Э6-бис (а): кабинет голосового управления «Сайтом» на реальном Postgres
 * (основная роль, тенант кабинета): переключатель (§5-бис.2, §5-бис.11;
 * (г): `on` — только с отчётом мастера, без него — `test`; полная проверка
 * (г) — voice-control-check.spec.ts), правила (строгий разбор), тарифный гейт «как у голоса»
 * (Business+), «сначала включите микрофон», экран рисков текущей версии;
 * выключить — всегда. Права маршрута (владелец/менеджер; оператор — 403) —
 * общий `SiteAccountGuard` с REQUIRE_ASSIST_MANAGER, как у голоса Э5.
 */
import { HttpException } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import { setPlan } from '../../modules/assist-billing/testing/billing-fixtures.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import {
  ChatStack,
  type ChatSite,
} from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { VOICE_CONTROL_RISKS_VERSION } from '../../modules/assist-site-voice-control/api-types';
import { VoiceControlSettingsService } from '../../modules/assist-site-voice-control/cabinet/voice-control-settings.service';
import type { AccountMembership } from '../../modules/site-core/account/roles';

jest.setTimeout(120_000);

describeDb('Э6-бис: кабинет голосового управления', () => {
  const st = new ChatStack();
  let svc: VoiceControlSettingsService;

  beforeAll(async () => {
    await st.init();
    svc = new VoiceControlSettingsService(new SitesDb(st.owner), st.owner);
    svc.env = { SONIOX_API_KEY: 'sx-test' };
  });
  afterAll(async () => {
    await st.close();
  });

  const owner = (s: ChatSite): AccountMembership => ({
    accountId: s.accountId,
    memberId: 'm',
    telegramId: s.ownerTelegramId,
    role: 'owner',
    productRoles: { qa: 'admin', assist: 'manager', assistAdmin: 'owner' },
  });

  async function code(p: Promise<unknown>): Promise<[number, string]> {
    try {
      await p;
    } catch (e) {
      if (e instanceof HttpException) {
        const r = e.getResponse() as { code: string };
        return [e.getStatus(), r.code];
      }
      throw e;
    }
    return [200, 'ok'];
  }

  async function mic(s: ChatSite, input: boolean) {
    await st.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: { voiceConfig: { schema: 1, input, output: false, voiceId: null } },
    });
  }

  it('по умолчанию выключено, правила по умолчанию (6 шагов, без запретов), включать нельзя без тарифа и голоса', async () => {
    const s = await st.site();
    const v = await svc.get(owner(s), s.siteId);
    expect(v).toMatchObject({
      state: 'off',
      available: false,
      reason: 'voice_off',
      risksVersion: VOICE_CONTROL_RISKS_VERSION,
    });
    expect(v.rules).toMatchObject({
      maxSteps: 6,
      denySelectors: [],
      confirmFill: false,
    });
  });

  it('включить: без тарифа с голосом — 402; без микрофона — 409; без экрана рисков — 400; со всем — on', async () => {
    const s = await st.site();
    const on = {
      state: 'on' as const,
      risksVersion: VOICE_CONTROL_RISKS_VERSION,
    };
    expect(await code(svc.save(owner(s), s.siteId, on))).toEqual([
      402,
      'VOICE_CONTROL_PLAN_REQUIRED',
    ]);
    await setPlan(st.owner, s.accountId, 'start');
    expect(await code(svc.save(owner(s), s.siteId, on))).toEqual([
      402,
      'VOICE_CONTROL_PLAN_REQUIRED',
    ]);
    await setPlan(st.owner, s.accountId, 'business');
    expect(await code(svc.save(owner(s), s.siteId, on))).toEqual([
      409,
      'VOICE_CONTROL_VOICE_REQUIRED',
    ]);
    await mic(s, true);
    expect(await code(svc.save(owner(s), s.siteId, { state: 'on' }))).toEqual([
      400,
      'VOICE_CONTROL_RISKS_REQUIRED',
    ]);
    expect(
      await code(
        svc.save(owner(s), s.siteId, { state: 'on', risksVersion: 'old' }),
      ),
    ).toEqual([400, 'VOICE_CONTROL_RISKS_REQUIRED']);
    // Э6-бис (г), решение владельца п.1: `on` — только после мастера Т-2;
    // без отчёта — 409, а `test` (только тестовая сессия) — можно.
    expect(await code(svc.save(owner(s), s.siteId, on))).toEqual([
      409,
      'VOICE_CONTROL_TEST_REQUIRED',
    ]);
    const v = await svc.save(owner(s), s.siteId, {
      ...on,
      state: 'test',
      rules: {
        denySelectors: ['.account'],
        denyWords: ['видалити'],
        maxSteps: 4,
      },
    });
    expect(v).toMatchObject({
      state: 'test',
      available: true,
      reason: 'state_test',
    });
    expect(v.rules).toMatchObject({ denySelectors: ['.account'], maxSteps: 4 });
  });

  it('выключить — всегда (и после снятия тарифа); (г) degraded — только из on/test; мусор — 400', async () => {
    const s = await st.site();
    await setPlan(st.owner, s.accountId, 'business');
    await mic(s, true);
    await svc.save(owner(s), s.siteId, {
      state: 'test',
      risksVersion: VOICE_CONTROL_RISKS_VERSION,
    });
    await setPlan(st.owner, s.accountId, 'start');
    expect((await svc.save(owner(s), s.siteId, { state: 'off' })).state).toBe(
      'off',
    );
    for (const state of ['ON', 'paused', undefined])
      expect(
        await code(svc.save(owner(s), s.siteId, { state } as never)),
      ).toEqual([400, 'VOICE_CONTROL_INVALID']);
    await setPlan(st.owner, s.accountId, 'business');
    expect(
      await code(
        svc.save(owner(s), s.siteId, {
          state: 'degraded',
          risksVersion: VOICE_CONTROL_RISKS_VERSION,
        }),
      ),
    ).toEqual([409, 'VOICE_CONTROL_INVALID']);
  });

  it('правила — строго: лишний ключ, селектор с `<`, лимит 16 — 400 с путями; ничего не сохранилось', async () => {
    const s = await st.site();
    const [status, c] = await code(
      svc.save(owner(s), s.siteId, {
        state: 'off',
        rules: { evil: true, denySelectors: ['<img>'], maxSteps: 16 },
      }),
    );
    expect([status, c]).toEqual([400, 'VOICE_CONTROL_INVALID']);
    const row = await st.owner.assistSite.findUnique({
      where: { siteId: s.siteId },
    });
    expect(row!.voiceControlSiteRules).toBeNull();
  });

  it('чужой кабинет сайт не видит (тенант)', async () => {
    const a = await st.site();
    const b = await st.site();
    expect((await code(svc.get(owner(b), a.siteId)))[0]).toBe(404);
  });
});
