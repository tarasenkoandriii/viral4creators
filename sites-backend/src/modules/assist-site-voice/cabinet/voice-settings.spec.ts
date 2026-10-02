/**
 * Кабинет голоса (Э5, §3.5) на реальном Postgres: включить — только на
 * тарифе с голосом, выключить — всегда; голос — из справочника провайдера;
 * прослушивание — платит суточный бюджет сайта и потолок голоса, повтор —
 * из кэша; права — manager (как персона).
 */
import { setPlan } from '../../assist-billing/testing/billing-fixtures.testing';
import { describeDb } from '../../assist-sandbox/testing/k3-stack.testing';
import { ChatStack } from '../../assist-site-chat/testing/chat-stack.testing';
import { SiteSetupController } from '../../assist-site-setup/site-setup.controller';
import { PRODUCT_ROLES_KEY } from '../../site-core/account/site-account.guard';
import {
  OWNER_PRODUCT_ROLES,
  type AccountMembership,
} from '../../site-core/account/roles';
import { ALLOW_APPS_KEY } from '../../telegram-auth/allow-apps.decorator';
import { SitesDb } from '../../../prisma/sites-db.service';
import { SiteSonioxStt } from '../public/soniox-stt.client';
import { SiteSonioxTts } from '../public/soniox-tts.client';
import { FakeSoniox } from '../testing/fake-soniox.testing';
import { VoiceSettingsController } from './voice-settings.controller';
import {
  VOICE_SAMPLE_TEXT,
  VoiceSettingsService,
} from './voice-settings.service';

jest.setTimeout(120_000);

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(
    (e as { getResponse?: () => { code?: string } } | null)?.getResponse?.()
      .code,
  ).toBe(code);
}

describeDb('кабинет голоса (Э5)', () => {
  const st = new ChatStack();
  const fake = new FakeSoniox();
  let svc: VoiceSettingsService;

  beforeAll(async () => {
    await st.init();
    const env = {
      ...st.env,
      SONIOX_API_KEY: 'sx',
      ASSIST_VOICE_ENABLED: 'true',
    };
    const stt = new SiteSonioxStt();
    stt.env = env;
    const tts = new SiteSonioxTts();
    tts.env = env;
    tts.fetch = fake.fetch;
    svc = new VoiceSettingsService(
      new SitesDb(st.owner),
      st.owner,
      st.budget,
      st.usage,
      stt,
      tts,
    );
    svc.env = env;
  });
  afterAll(async () => st.close());
  beforeEach(() => fake.reset());

  const member = (accountId: string): AccountMembership => ({
    accountId,
    memberId: 'm',
    telegramId: 1n,
    role: 'owner',
    productRoles: OWNER_PRODUCT_ROLES,
  });

  it('права — те же, что у персоны (assist: manager, приложение assist)', () => {
    for (const k of [PRODUCT_ROLES_KEY, ALLOW_APPS_KEY]) {
      expect(Reflect.getMetadata(k, VoiceSettingsController)).toEqual(
        Reflect.getMetadata(k, SiteSetupController),
      );
    }
  });

  it('пробный тариф: включить нельзя (VOICE_PLAN_REQUIRED), выключенное сохранить можно; Business — можно', async () => {
    const s = await st.site();
    const m = member(s.accountId);
    const view = await svc.get(m, s.siteId);
    expect(view).toMatchObject({
      config: { input: false, output: false, voiceId: null },
      available: false,
      reason: 'plan',
      defaultVoice: 'Maya',
      dailyCapMicroUsd: 0,
    });
    await expectCode(
      svc.save(m, s.siteId, { input: true, output: false, voiceId: null }),
      'VOICE_PLAN_REQUIRED',
    );
    await svc.save(m, s.siteId, {
      input: false,
      output: false,
      voiceId: 'Adrian',
    });
    await setPlan(st.owner, s.accountId, 'business');
    const on = await svc.save(m, s.siteId, {
      input: true,
      output: true,
      voiceId: 'Adrian',
    });
    expect(on).toMatchObject({
      config: { input: true, output: true, voiceId: 'Adrian' },
      available: true,
      reason: null,
      dailyCapMicroUsd: 1_500_000,
      voices: [
        expect.objectContaining({ id: 'Maya' }),
        expect.objectContaining({ id: 'Adrian' }),
      ],
    });
    // Тариф понизили — включённое остаётся сохранённым, выключить можно всегда.
    await setPlan(st.owner, s.accountId, 'start');
    expect((await svc.get(m, s.siteId)).reason).toBe('plan');
    await svc.save(m, s.siteId, {
      input: false,
      output: true,
      voiceId: 'Adrian',
    });
  });

  it('неизвестный голос и мусор — VOICE_CONFIG_INVALID с путями полей', async () => {
    const s = await st.site();
    await setPlan(st.owner, s.accountId, 'business');
    const m = member(s.accountId);
    await expectCode(
      svc.save(m, s.siteId, { input: true, output: true, voiceId: 'Nobody' }),
      'VOICE_CONFIG_INVALID',
    );
    await expectCode(
      svc.save(m, s.siteId, { input: 'yes' }),
      'VOICE_CONFIG_INVALID',
    );
  });

  it('прослушать: фраза на языке, платит бюджет сайта и голоса, повтор — из кэша без провайдера', async () => {
    const s = await st.site();
    await setPlan(st.owner, s.accountId, 'business');
    const m = member(s.accountId);
    const a = await svc.sample(m, s.siteId, { voiceId: 'Adrian', lang: 'ru' });
    expect(a.mime).toBe('audio/mpeg');
    expect(fake.calls.find((c) => c.path === 'tts:/tts')?.body).toMatchObject({
      voice: 'Adrian',
      language: 'ru',
      text: VOICE_SAMPLE_TEXT.ru,
    });
    const rows = await st.owner.siteAiUsage.findMany({
      where: { siteId: s.siteId, operation: 'assist-tts' },
    });
    expect(rows).toHaveLength(1);
    expect((await svc.get(m, s.siteId)).todaySpentMicroUsd).toBe(
      rows[0].costMicroUsd,
    );
    fake.calls.length = 0;
    await svc.sample(m, s.siteId, { voiceId: 'Adrian', lang: 'ru' });
    expect(fake.calls).toHaveLength(0);
    await expectCode(
      svc.sample(m, s.siteId, { voiceId: 'x"y' }),
      'VOICE_CONFIG_INVALID',
    );
  });

  it('прослушать на тарифе без голоса — VOICE_PLAN_REQUIRED, провайдер не зовётся', async () => {
    const s = await st.site();
    await expectCode(
      svc.sample(member(s.accountId), s.siteId, {}),
      'VOICE_PLAN_REQUIRED',
    );
    expect(fake.calls).toHaveLength(0);
  });
});
