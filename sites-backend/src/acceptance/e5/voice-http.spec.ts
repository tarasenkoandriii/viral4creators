/**
 * Э5: голос по HTTP на настоящем Postgres под ролью виджета — сырой парсер
 * записи (`audio/*` ≤ 1 МБ), допуск visitor-token, лимиты посетителя
 * (минутный — RATE_LIMITED, суточный — VOICE_LIMIT), байты озвучки мимо
 * конверта, поле `voice` публичного конфига, логи без текста речи.
 * Конвейер ответа — подделка стенда W2 (testing/widget-stack), Soniox — мок.
 */
import { Logger } from '@nestjs/common';
import * as request from 'supertest';
import { WIDGET_VISITOR_TOKEN_HEADER } from '../../brand';
import {
  seedUsage,
  setPlan,
} from '../../modules/assist-billing/testing/billing-fixtures.testing';
import {
  describeDb,
  randomV6Prefix,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { SiteVoiceService } from '../../modules/assist-site-voice/public/site-voice.service';
import { SiteSonioxStt } from '../../modules/assist-site-voice/public/soniox-stt.client';
import { SiteSonioxTts } from '../../modules/assist-site-voice/public/soniox-tts.client';
import {
  FakeSoniox,
  fakeRecording,
} from '../../modules/assist-site-voice/testing/fake-soniox.testing';
import {
  W_ORIGIN,
  domain,
  newRequestId,
  startWidgetStack,
  widgetFixture,
  type WidgetFixture,
  type WidgetStack,
} from '../../modules/assist-widget/testing/widget-stack.testing';

jest.setTimeout(120_000);

/**
 * Окна лимитов фиксированные (floor(now / минута)): серия запросов,
 * попавшая на смену минуты, начинается в одном окне и кончается в
 * другом — лимит «не срабатывает» (так упал CI на 1bfb425 в 18:48:00).
 * Перед серией ждём начала минуты, если до её конца меньше 20 с.
 */
async function awaitMinuteHeadroom(needMs = 20_000): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < needMs) await new Promise((r) => setTimeout(r, left + 50));
}

describeDb('Э5: голос виджета по HTTP', () => {
  let stack: WidgetStack;
  const fake = new FakeSoniox();
  const logs: string[] = [];
  const srv = () => stack.app.getHttpServer();

  beforeAll(async () => {
    // Перехват на ПРОТОТИПЕ Logger (как widget-logs.spec Э2): тестовый
    // модуль Nest ставит свой логгер при compile().
    for (const m of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, m)
        .mockImplementation((...args: unknown[]) => {
          logs.push(args.map(String).join(' '));
        });
    }
    stack = await startWidgetStack();
    const env = {
      ...process.env,
      SONIOX_API_KEY: 'sx-http',
      ASSIST_VOICE_ENABLED: 'true',
    };
    const stt = stack.app.get(SiteSonioxStt);
    stt.fetch = fake.fetch;
    stt.env = env;
    stt.pollDelayMs = 0;
    const tts = stack.app.get(SiteSonioxTts);
    tts.fetch = fake.fetch;
    tts.env = env;
    stack.app.get(SiteVoiceService).env = env;
  });
  afterAll(async () => {
    await stack?.close();
    jest.restoreAllMocks();
  });
  beforeEach(() => fake.reset());

  async function voiceFixture(
    opts: { voice?: boolean } = {},
  ): Promise<WidgetFixture> {
    const f = await widgetFixture(stack, [{ host: domain('e5') }]);
    await setPlan(stack.prisma, f.accountId, 'business');
    if (opts.voice !== false) {
      await stack.prisma.assistSite.update({
        where: { siteId: f.siteId },
        data: {
          voiceConfig: { schema: 1, input: true, output: true, voiceId: null },
        },
      });
    }
    return f;
  }

  async function session(
    f: WidgetFixture,
    ip = `${randomV6Prefix()}::1`,
  ): Promise<{ token: string; visitorId: string }> {
    const r = await request(srv())
      .post('/widget/v1/session')
      .set('Origin', W_ORIGIN)
      .set('X-Forwarded-For', ip)
      .send({ pk: f.pk, parentOrigin: f.hosts[0].origin })
      .expect(200);
    const token = r.body.data.visitorToken as string;
    const payload = JSON.parse(
      Buffer.from(token.split('.')[0], 'base64url').toString('utf8'),
    ) as { visitorId: string };
    return { token, visitorId: payload.visitorId };
  }

  const voicePost = (
    token: string | null,
    body: Buffer,
    type = 'audio/webm',
  ) => {
    const r = request(srv())
      .post('/widget/v1/voice')
      .set('Origin', W_ORIGIN)
      .set('Content-Type', type);
    if (token) r.set(WIDGET_VISITOR_TOKEN_HEADER, token);
    return r.send(body);
  };

  it('запись → текст и билет в конверте; в логах — ни текста речи, ни его кусков', async () => {
    const f = await voiceFixture();
    const { token } = await session(f);
    fake.transcript = 'Мій номер 0671234567 передзвоніть';
    logs.length = 0;
    const r = await voicePost(
      token,
      fakeRecording(8_000),
      'audio/webm;codecs=opus',
    ).expect(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({
      success: true,
      data: { text: 'Мій номер 0671234567 передзвоніть', lang: 'uk' },
    });
    expect(r.body.data.voiceTicket).toMatch(/^v1\./);
    expect(fake.count('DELETE', '/files/')).toBe(1);
    expect(fake.count('DELETE', '/transcriptions/')).toBe(1);
    const all = logs.join('\n');
    expect(all).toMatch(/voice site=/);
    expect(all).not.toMatch(/0671234567|передзвоніть|номер/);
  });

  it('без токена — SESSION_REQUIRED; не тот тип/больше 1 МБ — AUDIO_INVALID в конверте ДО провайдера', async () => {
    const f = await voiceFixture();
    const { token } = await session(f);
    const none = await voicePost(null, fakeRecording()).expect(401);
    expect(none.body.error.code).toBe('SESSION_REQUIRED');
    const { visitorId } = JSON.parse(
      Buffer.from(token.split('.')[0], 'base64url').toString('utf8'),
    ) as { visitorId: string };
    const big = await voicePost(token, fakeRecording(1024 * 1024 + 10)).expect(
      400,
    );
    // Отказ — парсером ДО маршрута: лимиты посетителя не тронуты, тело дальше не читалось.
    expect(
      await stack.prisma.assistRateBucket.count({
        where: { key: `${f.siteId}:${visitorId}` },
      }),
    ).toBe(0);
    expect(big.body).toMatchObject({
      success: false,
      error: { code: 'AUDIO_INVALID' },
    });
    const json = await request(srv())
      .post('/widget/v1/voice')
      .set('Origin', W_ORIGIN)
      .set(WIDGET_VISITOR_TOKEN_HEADER, token)
      .send({ audio: 'x' })
      .expect(400);
    expect(json.body.error.code).toBe('AUDIO_INVALID');
    expect(fake.calls).toHaveLength(0);
  });

  it('голос выключен владельцем — VOICE_UNAVAILABLE (403), провайдер не зовётся', async () => {
    const f = await voiceFixture({ voice: false });
    const { token } = await session(f);
    const r = await voicePost(token, fakeRecording()).expect(403);
    expect(r.body.error.code).toBe('VOICE_UNAVAILABLE');
    expect(fake.calls).toHaveLength(0);
  });

  it('лимиты посетителя: 7-я запись за минуту — RATE_LIMITED; суточный выбран — VOICE_LIMIT', async () => {
    const f = await voiceFixture();
    const { token, visitorId } = await session(f);
    await awaitMinuteHeadroom();
    for (let i = 0; i < 6; i++)
      await voicePost(token, fakeRecording()).expect(200);
    const seventh = await voicePost(token, fakeRecording()).expect(429);
    expect(seventh.body.error.code).toBe('RATE_LIMITED');

    const other = await session(f);
    const day = 24 * 60 * 60 * 1000;
    const start = Math.floor(Date.now() / day) * day;
    await stack.prisma.assistRateBucket.create({
      data: {
        scope: 'widget-stt-visitor-day',
        key: `${f.siteId}:${other.visitorId}`,
        bucket: new Date(start).toISOString(),
        count: 30,
        expiresAt: new Date(start + day),
      },
    });
    fake.calls.length = 0;
    const r = await voicePost(other.token, fakeRecording()).expect(429);
    expect(r.body.error.code).toBe('VOICE_LIMIT');
    expect(fake.calls).toHaveLength(0);
    expect(visitorId).not.toBe(other.visitorId);
  });

  it('лимит и на IP+сайт: новый visitor-token с того же IP окно не обнуляет', async () => {
    const f = await voiceFixture();
    const ip = `${randomV6Prefix()}::1`;
    // 3 посетителя × 6 записей = 18 — минутный потолок IP (§4.13 п.2–3).
    await awaitMinuteHeadroom();
    for (let v = 0; v < 3; v++) {
      const { token } = await session(f, ip);
      for (let i = 0; i < 6; i++)
        await voicePost(token, fakeRecording()).expect(200);
    }
    fake.calls.length = 0;
    const fresh = await session(f, ip);
    const r = await voicePost(fresh.token, fakeRecording()).expect(429);
    expect(r.body.error.code).toBe('RATE_LIMITED');
    expect(fake.calls).toHaveLength(0);
    // Другой IP того же сайта — своё окно.
    const other = await session(f);
    await voicePost(other.token, fakeRecording()).expect(200);

    // Суточный потолок IP выбран — VOICE_LIMIT и новому посетителю с него.
    const ip2 = `${randomV6Prefix()}::1`;
    await session(f, ip2);
    const before = await stack.prisma.assistRateBucket.findMany({
      where: {
        scope: 'widget-session-ip',
        key: { startsWith: `${f.siteId}:` },
      },
      select: { key: true },
    });
    const day = 24 * 60 * 60 * 1000;
    const start = Math.floor(Date.now() / day) * day;
    for (const { key } of before) {
      await stack.prisma.assistRateBucket.upsert({
        where: {
          scope_key_bucket: {
            scope: 'widget-stt-ip-site-day',
            key,
            bucket: new Date(start).toISOString(),
          },
        },
        create: {
          scope: 'widget-stt-ip-site-day',
          key,
          bucket: new Date(start).toISOString(),
          count: 90,
          expiresAt: new Date(start + day),
        },
        update: { count: 90 },
      });
    }
    fake.calls.length = 0;
    const late = await session(f, ip2);
    const d = await voicePost(late.token, fakeRecording()).expect(429);
    expect(d.body.error.code).toBe('VOICE_LIMIT');
    expect(fake.calls).toHaveLength(0);
    // Озвучка — так же: суточный потолок IP выбран — VOICE_LIMIT до поиска ответа.
    for (const { key } of before) {
      await stack.prisma.assistRateBucket.create({
        data: {
          scope: 'widget-tts-ip-site-day',
          key,
          bucket: new Date(start).toISOString(),
          count: 180,
          expiresAt: new Date(start + day),
        },
      });
    }
    const t = await request(srv())
      .post('/widget/v1/tts')
      .set('Origin', W_ORIGIN)
      .set(WIDGET_VISITOR_TOKEN_HEADER, late.token)
      .send({ messageId: 'm1' })
      .expect(429);
    expect(t.body.error.code).toBe('VOICE_LIMIT');
  });

  it('озвучка: байты mp3 мимо конверта, личный no-store; чужой id — NOT_FOUND', async () => {
    const f = await voiceFixture();
    const { token } = await session(f);
    const chat = await request(srv())
      .post('/widget/v1/chat')
      .set('Origin', W_ORIGIN)
      .set(WIDGET_VISITOR_TOKEN_HEADER, token)
      .set('Accept', 'application/json')
      .send({
        conversationId: null,
        clientRequestId: newRequestId(),
        question: 'Скільки коштує доставка?',
        page: { url: null, title: null },
        context: null,
        uiLang: 'uk',
      })
      .expect(200);
    const mid = chat.body.data.messageId as string;
    const r = await request(srv())
      .post('/widget/v1/tts')
      .set('Origin', W_ORIGIN)
      .set(WIDGET_VISITOR_TOKEN_HEADER, token)
      .send({ messageId: mid })
      .buffer(true)
      .parse((res, cb) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => cb(null, Buffer.concat(parts)));
      })
      .expect(200);
    expect(r.headers['content-type']).toBe('audio/mpeg');
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect((r.body as Buffer).equals(fake.ttsAudio)).toBe(true);
    const other = await session(f);
    const nf = await request(srv())
      .post('/widget/v1/tts')
      .set('Origin', W_ORIGIN)
      .set(WIDGET_VISITOR_TOKEN_HEADER, other.token)
      .send({ messageId: mid })
      .expect(404);
    expect(nf.body.error.code).toBe('NOT_FOUND');
    const bad = await request(srv())
      .post('/widget/v1/tts')
      .set('Origin', W_ORIGIN)
      .set(WIDGET_VISITOR_TOKEN_HEADER, token)
      .send({ messageId: '../../x' })
      .expect(400);
    expect(bad.body.success).toBe(false);
  });

  it('публичный конфиг: `voice` — только когда голос включён и чат активен', async () => {
    const on = await voiceFixture();
    const r1 = await request(srv())
      .get(`/widget/v1/config?pk=${on.pk}`)
      .expect(200);
    expect(r1.body.data.voice).toEqual({
      input: true,
      output: true,
      maxRecordMs: 30_000,
      minSpeechMs: 400,
      endSilenceMs: 1_000,
    });
    const off = await voiceFixture({ voice: false });
    const r2 = await request(srv())
      .get(`/widget/v1/config?pk=${off.pk}`)
      .expect(200);
    expect(r2.body.data.voice).toBeUndefined();
    // Лимит единиц выбран — чат lead_only, голоса нет (настройка и тариф
    // при этом голос разрешают — решает именно статус чата).
    await seedUsage(stack.prisma, on.accountId, { units: 1_200 });
    const r3 = await request(srv())
      .get(`/widget/v1/config?pk=${on.pk}`)
      .expect(200);
    expect(r3.body.data.status).toBe('lead_only');
    expect(r3.body.data.voice).toBeUndefined();
  });
});
