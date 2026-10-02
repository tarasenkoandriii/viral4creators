/**
 * Приёмка Э5 «Голос» (план, Приложение А «Этап 5») на реальном Postgres,
 * публичный код — под ролью assist_public, Soniox — мок (testing/fake-soniox):
 *  п.1 — запись удаляется у нас и у провайдера при успехе, отказе и
 *        таймауте (тот же шов, что у `soniox-stt.client.ts` генератора);
 *  п.2 — исчерпан потолок голоса — провайдер не зовётся, чат продолжает
 *        работать текстом (одно уведомление — сторона iframe, e2e виджета);
 *  п.3 — WER ≤ 15% на 30 записях — eval/wer.spec.ts (живой прогон — у
 *        владельца, `npm run eval:voice`).
 * Плюс деньги (§7.1–§7.3): голос — 2 единицы, доплата в засчитанном
 * диалоге, атомарный потолок голоса, учёт в site_ai_usage, кэш озвучки.
 */
import {
  setPlan,
  seedUsage,
  usageOf,
} from '../../modules/assist-billing/testing/billing-fixtures.testing';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { utcDay } from '../../modules/assist-site-chat/budget';
import {
  ChatStack,
  type ChatSite,
} from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { SiteVoiceService } from '../../modules/assist-site-voice/public/site-voice.service';
import { SiteSonioxStt } from '../../modules/assist-site-voice/public/soniox-stt.client';
import {
  SiteSonioxTts,
  ttsLanguage,
} from '../../modules/assist-site-voice/public/soniox-tts.client';
import { ttsCacheKey } from '../../modules/assist-site-voice/public/tts-cache';
import { speakableText } from '../../modules/assist-site-voice/public/tts-text';
import { VOICE_DEFAULTS } from '../../modules/assist-site-voice/voice-config';
import {
  FakeSoniox,
  fakeRecording,
  type SttScenario,
} from '../../modules/assist-site-voice/testing/fake-soniox.testing';

jest.setTimeout(180_000);

describeDb('Приёмка Э5 — голос виджета', () => {
  const st = new ChatStack();
  const fake = new FakeSoniox();
  let voice: SiteVoiceService;
  let stt: SiteSonioxStt;
  let tts: SiteSonioxTts;

  beforeAll(async () => {
    await st.init();
    const env = {
      ...st.env,
      SONIOX_API_KEY: 'sx-test',
      ASSIST_VOICE_ENABLED: 'true',
    };
    stt = new SiteSonioxStt();
    stt.fetch = fake.fetch;
    stt.env = env;
    stt.pollDelayMs = 0;
    stt.cleanupGraceMs = 200;
    tts = new SiteSonioxTts();
    tts.fetch = fake.fetch;
    tts.env = env;
    voice = new SiteVoiceService(st.publicDb, st.budget, st.usage, stt, tts);
    voice.env = env;
  });
  afterAll(async () => {
    await st.close();
  });
  beforeEach(() => {
    fake.reset();
    stt.attemptDeadlineMs = 2_000;
    st.model.mode = 'honest';
    st.model.calls.length = 0;
  });

  /** Сайт с тарифом Business и включённым голосом. */
  async function voiceSite(
    opts: {
      plan?: 'business' | 'trial' | 'start';
      input?: boolean;
      output?: boolean;
      cap?: number | null;
    } = {},
  ): Promise<ChatSite> {
    const s = await st.stand('shop');
    if (opts.plan !== 'trial')
      await setPlan(st.owner, s.accountId, opts.plan ?? 'business');
    await st.owner.assistSite.update({
      where: { siteId: s.siteId },
      data: {
        voiceConfig: {
          schema: 1,
          input: opts.input ?? true,
          output: opts.output ?? true,
          voiceId: null,
        },
        voiceDailyCapMicroUsd: opts.cap ?? null,
      },
    });
    return s;
  }

  const ctx = (s: ChatSite, visitor = st.visitor()) => ({
    site: s.ctx(),
    visitor,
  });

  async function voiceRow(siteId: string) {
    const rows = await st.owner.$queryRawUnsafe<
      Array<{ spent: bigint; reserved: bigint }>
    >(
      `SELECT "spentMicroUsd" AS spent, "reservedMicroUsd" AS reserved FROM "sites"."assist_budget_days"
        WHERE "scope" = 'voice' AND "key" = $1 AND "day" = $2`,
      siteId,
      utcDay(new Date()),
    );
    return rows[0]
      ? { spent: Number(rows[0].spent), reserved: Number(rows[0].reserved) }
      : null;
  }

  async function usageRows(siteId: string, operation: string) {
    return st.owner.siteAiUsage.findMany({ where: { siteId, operation } });
  }

  // ── п.1: запись не остаётся ни у нас, ни у провайдера ───────────────────

  it('п.1 успех: текст и билет; файл и транскрипция удалены у Soniox ПОСЛЕ разбора; звук у нас затёрт; расход — секунды Soniox', async () => {
    const s = await voiceSite();
    const audio = fakeRecording();
    const r = await voice.transcribe(ctx(s), audio, 'audio/webm;codecs=opus');
    expect(r).toMatchObject({
      ok: true,
      text: 'Скільки коштує доставка?',
      lang: 'uk',
    });
    expect(r.ok && r.ticket).toMatch(/^v1\.\d+\./);
    const paths = fake.calls.map((c) => `${c.method} ${c.path}`);
    const lastRead = paths.findIndex((p) => p.endsWith('/transcript'));
    const delFile = paths.findIndex((p) => /^DELETE \/files\//.test(p));
    const delTr = paths.findIndex((p) => /^DELETE \/transcriptions\//.test(p));
    expect(lastRead).toBeGreaterThan(0);
    expect(delFile).toBeGreaterThan(lastRead);
    expect(delTr).toBeGreaterThan(delFile);
    // Языки сайта — подсказкой, не ограничением; запись ушла как есть.
    const create = fake.calls.find(
      (c) => c.method === 'POST' && c.path === '/transcriptions',
    );
    expect(create?.body).toMatchObject({
      model: 'stt-async-v5',
      enable_language_identification: true,
    });
    expect(fake.calls[0].body).toEqual({
      file: { size: audio.length, type: 'audio/webm' },
    });
    // У нас звук не живёт дольше запроса: буфер затёрт, таблиц под звук нет.
    expect(audio.every((b) => b === 0)).toBe(true);
    expect(
      await st.owner.assistSiteTtsCache.count({ where: { siteId: s.siteId } }),
    ).toBe(0);
    const rows = await usageRows(s.siteId, 'assist-stt');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: 'soniox-stt-async',
      provider: 'SONIOX',
      seconds: 2,
    });
    expect(rows[0].costMicroUsd).toBeGreaterThan(0);
    const v = await voiceRow(s.siteId);
    expect(v).toEqual({ spent: rows[0].costMicroUsd, reserved: 0 });
  });

  const failures: Array<
    [SttScenario, 'not_heard' | 'upstream', { file: number; tr: number }]
  > = [
    ['upload-fails', 'upstream', { file: 0, tr: 0 }],
    ['create-fails', 'upstream', { file: 1, tr: 0 }],
    ['status-error', 'upstream', { file: 1, tr: 1 }],
    ['silence', 'not_heard', { file: 1, tr: 1 }],
    ['network-drop', 'upstream', { file: 1, tr: 1 }],
    ['never-completes', 'upstream', { file: 1, tr: 1 }],
  ];
  it.each(failures)(
    'п.1 отказ/таймаут (%s): ответ %s, удалено у Soniox всё созданное, резерв голоса снят, звук затёрт',
    async (scenario, failure, deleted) => {
      const s = await voiceSite();
      fake.stt = scenario;
      if (scenario === 'never-completes') stt.attemptDeadlineMs = 60;
      const audio = fakeRecording();
      const r = await voice.transcribe(ctx(s), audio, 'audio/webm');
      expect(r).toEqual({ ok: false, failure });
      expect(fake.count('DELETE', '/files/')).toBe(deleted.file);
      expect(fake.count('DELETE', '/transcriptions/')).toBe(deleted.tr);
      // Удаляется ровно загруженное (id из ответа провайдера), не «что-то».
      expect(
        fake.calls
          .filter((c) => c.method === 'DELETE')
          .every((c) => /^\/(files\/f|transcriptions\/t)\d+$/.test(c.path)),
      ).toBe(true);
      expect(audio.every((b) => b === 0)).toBe(true);
      expect((await voiceRow(s.siteId))?.reserved).toBe(0);
    },
  );

  it('п.1 транскрипция ещё обрабатывается (409) — удаление повторяется, пока провайдер не отпустит', async () => {
    const s = await voiceSite();
    fake.stt = 'busy-delete';
    const r = await voice.transcribe(ctx(s), fakeRecording(), 'audio/ogg');
    expect(r.ok).toBe(true);
    // Заголовок говорил ogg, байты — webm: провайдеру — тип по байтам.
    expect(fake.calls[0].body).toMatchObject({ file: { type: 'audio/webm' } });
    expect(fake.count('DELETE', '/files/')).toBe(1);
    expect(fake.count('DELETE', '/transcriptions/')).toBe(3);
  });

  it('п.1 запись не того формата/размера — отказ ДО провайдера и денег', async () => {
    const s = await voiceSite();
    for (const [bytes, type] of [
      [fakeRecording(), 'video/webm'],
      [fakeRecording(), undefined],
      [fakeRecording(100), 'audio/webm'],
      [fakeRecording(1024 * 1024 + 1), 'audio/webm'],
      // Заголовку не верим: не звук под `audio/webm` — тоже отказ.
      [Buffer.from('<html>'.padEnd(4_096, ' ')), 'audio/webm'],
    ] as const) {
      expect(await voice.transcribe(ctx(s), bytes, type)).toEqual({
        ok: false,
        failure: 'audio_invalid',
      });
    }
    expect(fake.calls).toHaveLength(0);
    expect(await voiceRow(s.siteId)).toBeNull();
  });

  // ── п.2: потолок голоса — текстом дальше ─────────────────────────────────

  it('п.2 потолок голоса сайта исчерпан → limit без вызова провайдера; чат отвечает текстом; озвучка — тоже limit', async () => {
    const s = await voiceSite({ cap: 1 });
    const visitor = st.visitor();
    expect(
      await voice.transcribe(ctx(s, visitor), fakeRecording(), 'audio/webm'),
    ).toEqual({
      ok: false,
      failure: 'limit',
    });
    expect(fake.calls).toHaveLength(0);
    const text = await st.ask(s, 'Скільки коштує доставка Новою поштою?', {
      visitor,
    });
    expect(text.error).toBeNull();
    expect(text.text.length).toBeGreaterThan(0);
    expect(st.model.calls).toHaveLength(1);
    const said = await voice.speak(ctx(s, visitor), text.meta!.messageId);
    expect(said).toEqual({ ok: false, failure: 'limit' });
    expect(fake.calls).toHaveLength(0);
    // Голос не тронул деньги дня ответа: строка сайта — только ответ модели.
    expect((await voiceRow(s.siteId))?.spent ?? 0).toBe(0);
  });

  it('п.2 потолок голоса атомарный: 10 параллельных резервов при месте на 3 — ровно 3', async () => {
    const s = await voiceSite();
    const est = 1_000;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        st.budget.reserve(st.publicDb, {
          siteId: s.siteId,
          siteCapMicroUsd: 10_000_000,
          estMicroUsd: est,
          voiceCapMicroUsd: 3 * est,
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(
      results.filter((r) => !r.ok && r.denied === 'voice_budget'),
    ).toHaveLength(7);
    // Брошенные резервы снимает крон — и строку голоса тоже.
    const later = new Date(Date.now() + 10 * 60_000);
    expect(await st.budget.sweep(st.owner, later, s.siteId)).toBe(3);
    expect(await voiceRow(s.siteId)).toEqual({ spent: 0, reserved: 0 });
    expect(
      (await st.budgetRow('site', s.siteId, utcDay(new Date())))?.reserved,
    ).toBe(0);
  });

  it('п.2 лимит единиц периода выбран → голос limit, провайдер не зовётся', async () => {
    const s = await voiceSite();
    await seedUsage(st.owner, s.accountId, { units: 1_200 });
    expect(
      await voice.transcribe(ctx(s), fakeRecording(), 'audio/webm'),
    ).toEqual({ ok: false, failure: 'limit' });
    expect(fake.calls).toHaveLength(0);
  });

  // ── деньги: вес 2 ────────────────────────────────────────────────────────

  it('вопрос голосом (билет сошёлся) — диалог за 2 единицы; без билета/с чужим текстом — за 1', async () => {
    const s = await voiceSite();
    const visitor = st.visitor();
    const heard = await voice.transcribe(
      ctx(s, visitor),
      fakeRecording(),
      'audio/webm',
    );
    if (!heard.ok) throw new Error('распознавание');
    const a = await st.ask(s, heard.text, {
      visitor,
      voiceTicket: heard.ticket,
    });
    expect(a.error).toBeNull();
    expect(await usageOf(st.owner, s.accountId)).toMatchObject({
      units: 2,
      dialogs: 1,
    });
    const conv = await st.owner.assistSiteConversation.findUniqueOrThrow({
      where: { id: a.meta!.conversationId },
    });
    expect(conv.voice).toBe(true);

    // Билет чужого посетителя, билет на другой текст, подделка — вес 1:
    // засчитанные диалоги этих вопросов — по единице, отметки голоса нет.
    const s2 = await voiceSite();
    const v2 = st.visitor();
    const h2 = await voice.transcribe(
      ctx(s2, v2),
      fakeRecording(),
      'audio/webm',
    );
    if (!h2.ok) throw new Error('распознавание');
    const asked = [
      await st.ask(s2, h2.text, {
        visitor: st.visitor(),
        voiceTicket: h2.ticket,
      }),
      await st.ask(s2, 'Яка гарантія на ноутбук?', {
        visitor: v2,
        voiceTicket: h2.ticket,
      }),
      await st.ask(s2, 'Скільки коштує діагностика ноутбука?', {
        visitor: st.visitor(),
        voiceTicket: 'v1.9999999999.' + 'A'.repeat(43),
      }),
    ];
    for (const r of asked) {
      const c = await st.owner.assistSiteConversation.findUniqueOrThrow({
        where: { id: r.meta!.conversationId },
      });
      expect(c.voice).toBe(false);
    }
    const u2 = await usageOf(st.owner, s2.accountId);
    expect(u2!.dialogs).toBeGreaterThan(0);
    expect(u2!.units).toBe(u2!.dialogs);
  });

  it('озвучка ответа в засчитанном текстовом диалоге — доплата до 2; второй раз — без доплаты и из кэша; чужой ответ — not_found', async () => {
    const s = await voiceSite();
    const visitor = st.visitor();
    const a = await st.ask(s, 'Яка гарантія на електрочайник?', { visitor });
    expect(await usageOf(st.owner, s.accountId)).toMatchObject({ units: 1 });
    const first = await voice.speak(ctx(s, visitor), a.meta!.messageId);
    expect(first).toMatchObject({
      ok: true,
      mime: 'audio/mpeg',
      cached: false,
    });
    expect(first.ok && first.audio.equals(fake.ttsAudio)).toBe(true);
    expect(await usageOf(st.owner, s.accountId)).toMatchObject({
      units: 2,
      dialogs: 1,
    });
    const sent = fake.calls.find((c) => c.path === 'tts:/tts')?.body as Record<
      string,
      unknown
    >;
    expect(sent).toMatchObject({
      model: 'tts-rt-v2',
      voice: 'Maya',
      audio_format: 'mp3',
      language: 'uk',
    });
    expect(String(sent.text)).not.toMatch(/\[S\d|\*\*|https?:/);
    const ttsRows = await usageRows(s.siteId, 'assist-tts');
    expect(ttsRows).toHaveLength(1);
    expect(ttsRows[0]).toMatchObject({
      model: 'soniox-tts',
      characters: String(sent.text).length,
    });

    fake.calls.length = 0;
    const again = await voice.speak(ctx(s, visitor), a.meta!.messageId);
    expect(again).toMatchObject({ ok: true, cached: true });
    expect(fake.calls).toHaveLength(0);
    expect(await usageOf(st.owner, s.accountId)).toMatchObject({ units: 2 });
    expect(await usageRows(s.siteId, 'assist-tts')).toHaveLength(1);

    // Чужой посетитель, чужой сайт — неотличимо от «нет такого».
    expect(await voice.speak(ctx(s, st.visitor()), a.meta!.messageId)).toEqual({
      ok: false,
      failure: 'not_found',
    });
    const other = await voiceSite();
    expect(await voice.speak(ctx(other, visitor), a.meta!.messageId)).toEqual({
      ok: false,
      failure: 'not_found',
    });
  });

  it('доплата не поместилась (лимит выбран после текстового ответа) — озвучка из кэша всё равно limit, отметка голоса снята', async () => {
    const s = await voiceSite();
    const first = st.visitor();
    const a = await st.ask(s, 'Яка гарантія на електрочайник?', {
      visitor: first,
    });
    expect((await voice.speak(ctx(s, first), a.meta!.messageId)).ok).toBe(true);
    // Второй посетитель, ответ модели; его озвучка уже лежит в кэше (тот же
    // текст озвучивали раньше) — денег провайдеру не надо, но доплата
    // единицы — нужна, а лимит выбран.
    const second = st.visitor();
    const b = await st.ask(s, 'Скільки коштує діагностика ноутбука?', {
      visitor: second,
    });
    expect(st.model.calls.length).toBeGreaterThan(0);
    const msg = await st.owner.assistSiteMessage.findUniqueOrThrow({
      where: { id: b.meta!.messageId },
    });
    const text = speakableText(msg.text, VOICE_DEFAULTS.ttsMaxChars);
    await st.owner.assistSiteTtsCache.create({
      data: {
        id: `pre-${b.meta!.messageId}`,
        siteId: s.siteId,
        key: ttsCacheKey({
          voice: 'Maya',
          lang: ttsLanguage(msg.lang, text),
          model: 'tts-rt-v2',
          text,
        }),
        voice: 'Maya',
        lang: 'uk',
        mime: 'audio/mpeg',
        audio: Buffer.from('cached'),
        characters: text.length,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await seedUsage(st.owner, s.accountId, { units: 1_200 });
    fake.calls.length = 0;
    expect(await voice.speak(ctx(s, second), b.meta!.messageId)).toEqual({
      ok: false,
      failure: 'limit',
    });
    expect(fake.calls).toHaveLength(0);
    const conv = await st.owner.assistSiteConversation.findUniqueOrThrow({
      where: { id: b.meta!.conversationId },
    });
    expect(conv.voice).toBe(false);
  });

  it('кэш озвучки — только своего сайта: запись чужого сайта с тем же ключом не отдаётся', async () => {
    const a = await voiceSite();
    const b = await voiceSite();
    const visitor = st.visitor();
    const ans = await st.ask(b, 'Яка гарантія на електрочайник?', { visitor });
    const msg = await st.owner.assistSiteMessage.findUniqueOrThrow({
      where: { id: ans.meta!.messageId },
    });
    const text = speakableText(msg.text, VOICE_DEFAULTS.ttsMaxChars);
    const key = ttsCacheKey({
      voice: 'Maya',
      lang: ttsLanguage(msg.lang, text),
      model: 'tts-rt-v2',
      text,
    });
    await st.owner.assistSiteTtsCache.create({
      data: {
        id: `x-${a.siteId}`,
        siteId: a.siteId,
        key,
        voice: 'Maya',
        lang: 'uk',
        mime: 'audio/mpeg',
        audio: Buffer.from('чужое'),
        characters: 5,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const r = await voice.speak(ctx(b, visitor), ans.meta!.messageId);
    expect(r).toMatchObject({ ok: true, cached: false });
    expect(r.ok && r.audio.equals(fake.ttsAudio)).toBe(true);
    expect(fake.count('POST', 'tts:/tts')).toBe(1);
  });

  it('сбой синтеза — upstream, резерв снят, кэш не записан, доплаты нет', async () => {
    const s = await voiceSite();
    const visitor = st.visitor();
    const a = await st.ask(s, 'Яка гарантія на електрочайник?', { visitor });
    fake.tts = 'fail';
    expect(await voice.speak(ctx(s, visitor), a.meta!.messageId)).toEqual({
      ok: false,
      failure: 'upstream',
    });
    expect(
      await st.owner.assistSiteTtsCache.count({ where: { siteId: s.siteId } }),
    ).toBe(0);
    expect((await voiceRow(s.siteId))?.reserved).toBe(0);
    expect(await usageOf(st.owner, s.accountId)).toMatchObject({ units: 1 });
  });

  // ── доступность ──────────────────────────────────────────────────────────

  it('голос только на тарифе с голосом и по включению владельцем; рубильник платформы и нет ключа — выключено', async () => {
    const trial = await voiceSite({ plan: 'trial' });
    expect(
      await voice.transcribe(ctx(trial), fakeRecording(), 'audio/webm'),
    ).toEqual({ ok: false, failure: 'unavailable' });
    const start = await voiceSite({ plan: 'start' });
    expect((await voice.access(start.ctx(), { planId: 'start' })).reason).toBe(
      'plan',
    );
    const off = await voiceSite({ input: false, output: true });
    expect(
      await voice.transcribe(ctx(off), fakeRecording(), 'audio/webm'),
    ).toEqual({ ok: false, failure: 'unavailable' });
    const on = await voiceSite();
    expect(await voice.access(on.ctx(), { planId: 'business' })).toMatchObject({
      input: true,
      output: true,
      reason: null,
      capMicroUsd: 1_500_000,
    });
    const saved = voice.env;
    try {
      voice.env = { ...saved, ASSIST_VOICE_ENABLED: 'false' };
      expect(
        (await voice.access(on.ctx(), { planId: 'business' })).reason,
      ).toBe('platform_off');
      voice.env = saved;
      stt.env = { ...saved, SONIOX_API_KEY: '' };
      expect(
        (await voice.access(on.ctx(), { planId: 'business' })).reason,
      ).toBe('no_provider');
    } finally {
      voice.env = saved;
      stt.env = saved;
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('ретенция: просроченная озвучка удаляется, свежая — нет', async () => {
    const s = await voiceSite();
    const visitor = st.visitor();
    const a = await st.ask(s, 'Яка гарантія на електрочайник?', { visitor });
    expect((await voice.speak(ctx(s, visitor), a.meta!.messageId)).ok).toBe(
      true,
    );
    await st.owner.assistSiteTtsCache.create({
      data: {
        id: `old-${s.siteId}`,
        siteId: s.siteId,
        key: 'site:old',
        voice: 'Maya',
        lang: 'uk',
        mime: 'audio/mpeg',
        audio: Buffer.from('old'),
        characters: 3,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    const r = await st.retention.run(new Date());
    expect(r.ttsCacheDeleted).toBeGreaterThanOrEqual(1);
    const left = await st.owner.assistSiteTtsCache.findMany({
      where: { siteId: s.siteId },
      select: { key: true },
    });
    expect(left).toHaveLength(1);
    expect(left[0].key).not.toBe('site:old');
  });
});
