/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые двойники */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  ProviderUsageService,
  VOICE_USAGE_WINDOW_DAYS,
} from './provider-usage.service';

/**
 * Кем продукт пользуется сейчас (запрос владельца 30.09.2026:
 * ElevenLabs отложен, а сторож остатков будил канал каждый день).
 */
const NOW = new Date('2026-09-30T12:00:00Z');

function make(opts: {
  setting?: string | null;
  brands?: string[];
  sessions?: string[];
  settingsFail?: boolean;
  sessionFailsOn?: string;
  assistant?: string | null;
  spentOn?: string[];
}) {
  const brandManifest = {
    findFirst: jest.fn(async ({ where }: any) =>
      (opts.brands ?? []).includes(where.ttsProvider) ? { id: 'b1' } : null,
    ),
  };
  const session = {
    findFirst: jest.fn(async ({ where }: any) => {
      if (where.data.equals === opts.sessionFailsOn) {
        throw new Error('таймаут запроса');
      }
      return (opts.sessions ?? []).includes(where.data.equals)
        ? { id: 's1' }
        : null;
    }),
  };
  const aiUsage = {
    findFirst: jest.fn(async ({ where }: any) =>
      (opts.spentOn ?? []).includes(where.provider) ? { id: 'u1' } : null,
    ),
  };
  const settings = {
    get: jest.fn(async (key: string) => {
      if (opts.settingsFail) throw new Error('база недоступна');
      if (key === 'voice_assistant_voice') return opts.assistant ?? null;
      return opts.setting ?? null;
    }),
  };
  const svc = new ProviderUsageService(
    { brandManifest, session, aiUsage } as never,
    settings as never,
  );
  return { svc, brandManifest, session, aiUsage };
}

describe('ProviderUsageService', () => {
  let restoreEnv: string | undefined;
  beforeEach(() => {
    // `TTS_PROVIDER` — запасной источник выбора; чужое значение из
    // окружения разработчика подменило бы проверяемый случай.
    restoreEnv = process.env.TTS_PROVIDER;
    delete process.env.TTS_PROVIDER;
  });
  afterEach(() => {
    if (restoreEnv === undefined) delete process.env.TTS_PROVIDER;
    else process.env.TTS_PROVIDER = restoreEnv;
  });

  it('живой случай: выбран Resemble, ссылок на ElevenLabs нет — ElevenLabs не используется', async () => {
    const { svc } = make({ setting: 'resemble' });
    const { unused } = await svc.usage(NOW);
    expect([...unused.keys()]).toEqual(['ELEVENLABS']);
    expect(unused.get('ELEVENLABS')).toContain('Озвучкой по умолчанию');
    expect(unused.get('ELEVENLABS')).toContain('resemble');
  });

  it('выбранный «Озвучкой по умолчанию» используется без всяких запросов к базе', async () => {
    const { svc, brandManifest } = make({ setting: 'elevenlabs' });
    const { unused } = await svc.usage(NOW);
    expect(unused.has('ELEVENLABS')).toBe(false);
    // Resemble при этом не выбран и ни на что не ссылается.
    expect(unused.has('RESEMBLE')).toBe(true);
    expect(
      brandManifest.findFirst.mock.calls.some(
        (c: any[]) => c[0].where.ttsProvider === 'elevenlabs',
      ),
    ).toBe(false);
  });

  it('брендбук с голосом провайдера делает его используемым, что бы ни стояло в селекторе', async () => {
    // Такой брендбук синтезирует именно через этот провайдер
    // (`resolveByKey`), и молчать о его остатке — вставший продукт.
    const { svc } = make({ setting: 'resemble', brands: ['elevenlabs'] });
    expect((await svc.usage(NOW)).unused.size).toBe(0);
  });

  it('снимок бренда в сессии — тоже явная ссылка', async () => {
    const { svc } = make({ setting: 'resemble', sessions: ['elevenlabs'] });
    expect((await svc.usage(NOW)).unused.size).toBe(0);
  });

  it('ссылки ищутся только в окне свежести и не среди удалённых сессий', async () => {
    // Без окна старые брендбуки держали бы отложенного провайдера
    // «используемым» вечно: тег провайдера пишется при сохранении
    // голоса и сам не меняется.
    const { svc, brandManifest, session } = make({ setting: 'resemble' });
    await svc.usage(NOW);
    const since = new Date(
      NOW.getTime() - VOICE_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(brandManifest.findFirst.mock.calls[0][0].where.updatedAt).toEqual({
      gte: since,
    });
    const where = session.findFirst.mock.calls[0][0].where;
    expect(where.lastActivityAt).toEqual({ gte: since });
    expect(where.deletedAt).toBeNull();
    expect(where.data.path).toEqual(['brandManifestSnapshot', 'ttsProvider']);
  });

  it('Soniox и прочие в расчёт не входят — о них судить не по чему', async () => {
    // Ключ Soniox общий с распознаванием речи: «не выбран для озвучки»
    // не значит «не используется».
    const { svc } = make({ setting: 'soniox' });
    const { unused } = await svc.usage(NOW);
    expect(unused.has('SONIOX')).toBe(false);
    expect([...unused.keys()].sort()).toEqual(['ELEVENLABS', 'RESEMBLE']);
  });

  it('база не ответила — используются все: лишний крик дешевле тихого пропуска', async () => {
    const { svc } = make({ settingsFail: true });
    expect((await svc.usage(NOW)).unused.size).toBe(0);
  });

  it('сбой на середине не оставляет половинчатый ответ', async () => {
    // ElevenLabs уже признан неиспользуемым, а на Resemble запрос упал:
    // отдать «ElevenLabs не используется» значило бы решать по неполным
    // данным — сторожим всех.
    const { svc } = make({ setting: 'soniox', sessionFailsOn: 'resemble' });
    expect((await svc.usage(NOW)).unused.size).toBe(0);
  });

  it('фактический расход за окно делает провайдера используемым', async () => {
    // Аудит 30.09.2026: прослушивание с явным провайдером, виртуальная
    // студия, клон отправителя — ни одна настройка их не видит, а
    // строку расхода пишут все.
    const { svc, aiUsage } = make({
      setting: 'resemble',
      spentOn: ['ELEVENLABS'],
    });
    expect((await svc.usage(NOW)).unused.size).toBe(0);
    const since = new Date(
      NOW.getTime() - VOICE_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(aiUsage.findFirst.mock.calls[0][0].where).toEqual({
      provider: 'ELEVENLABS',
      createdAt: { gte: since },
    });
  });

  it('расход по ДРУГОМУ провайдеру чужого не спасает', async () => {
    const { svc } = make({ setting: 'soniox', spentOn: ['RESEMBLE'] });
    expect([...(await svc.usage(NOW)).unused.keys()]).toEqual(['ELEVENLABS']);
  });

  it('голос помощника — отдельный выбор, и он тоже «используется»', async () => {
    // Пока мастер молчит, расхода по нему нет, а кончившийся баланс
    // заглушит его на первой же подсказке.
    const { svc } = make({
      setting: 'resemble',
      assistant: JSON.stringify({ provider: 'elevenlabs', voiceId: 'v1' }),
    });
    expect((await svc.usage(NOW)).unused.size).toBe(0);
  });

  it('причина называет и выбор по умолчанию, и голос помощника, и расход', async () => {
    const { svc } = make({ setting: 'resemble' });
    const note = (await svc.usage(NOW)).unused.get('ELEVENLABS')!;
    expect(note).toContain('не используется');
    expect(note).toContain('голосом помощника (сейчас: soniox)');
    expect(note).toContain('расхода');
  });
});
