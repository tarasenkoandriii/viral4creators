/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  POSTPROD_DEADLINE_MS,
  PostProductionService,
  postProductionExpired,
} from './postprod.service';
import {
  ExportVariant,
  GeneratedVideo,
  GenerationStatus,
} from '../../common/types/generation.types';

const VIDEO: GeneratedVideo = {
  generatedVideoId: 'v1',
  pathname: 'sessions/s1/generated.mp4',
  fileName: 'generated.mp4',
  mimeType: 'video/mp4',
  status: GenerationStatus.COMPLETE,
  initiatedAt: new Date(),
  downloadUrl: 'https://blob.test/sessions/s1/generated.mp4',
  aspectRatio: '4:5',
  renderedAspectRatio: '9:16',
  reframePending: true,
};

function session(over: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    brandManifestSnapshot: { voiceMode: 'veo' },
    generationPrompt: { finalVoiceoverScript: 'Это работает. Берите сейчас.' },
    ...over,
  };
}

function build(
  over: {
    configured?: boolean;
    ttsConfigured?: boolean;
    ttsProviderKey?: string;
    claimed?: boolean;
    exportClaimed?: boolean;
    denied?: string;
    session?: Record<string, unknown>;
  } = {},
) {
  const api = {
    configured: jest.fn().mockReturnValue(over.configured ?? true),
    submit: jest.fn().mockResolvedValue({ jobId: 'job1', status: 'queued' }),
    status: jest.fn().mockResolvedValue({ status: 'pending' }),
  };
  const tts = {
    providerKey: over.ttsProviderKey ?? 'elevenlabs',
    configured: jest.fn().mockReturnValue(over.ttsConfigured ?? true),
    synthesize: jest.fn().mockResolvedValue({
      ok: true,
      audio: Buffer.from([1, 2, 3]),
      mimeType: 'audio/mpeg',
      characters: 28,
      voiceId: 'voice-1',
      model: 'eleven_multilingual_v2',
    }),
  };
  const blob = {
    uploadBuffer: jest
      .fn()
      .mockImplementation((pathname: string) =>
        Promise.resolve({ url: `https://blob.test/${pathname}` }),
      ),
  };
  const sessions = {
    updateSession: jest.fn().mockResolvedValue(undefined),
    getSession: jest.fn().mockResolvedValue(over.session ?? session()),
    claimPostProduction: jest.fn().mockResolvedValue(over.claimed ?? true),
    // Автоэкспорт, оба яруса (Е-2.1 шестого аудита) — по умолчанию замок
    // всегда свободен, чтобы существующие тесты startExport/pollExport
    // (написанные до этой правки) проходили как раньше.
    claimWork: jest.fn().mockResolvedValue(over.exportClaimed ?? true),
    releaseWork: jest.fn().mockResolvedValue(undefined),
  };
  const aiUsage = { record: jest.fn() };
  const plans = {
    assertCanSpendSession: jest
      .fn()
      .mockImplementation(() =>
        over.denied
          ? Promise.reject(new Error(over.denied))
          : Promise.resolve(),
      ),
  };
  // Этап 91: `resolveByKey` тоже отдаёт `tts` — для большинства тестов
  // неважно, каким ключом его позвали, а тесты про явный провайдер
  // (ниже) сверяют сам факт и аргумент вызова через мок `ttsResolver`.
  const ttsResolver = {
    resolve: jest.fn().mockResolvedValue(tts),
    resolveByKey: jest.fn().mockReturnValue(tts),
  };
  return {
    svc: new PostProductionService(
      api as any,
      ttsResolver as any,
      blob as any,
      sessions as any,
      aiUsage as any,
      plans as any,
    ),
    plans,
    api,
    tts,
    ttsResolver,
    blob,
    sessions,
    aiUsage,
  };
}

describe('PostProductionService (ТЗ §15.4/§16.1)', () => {
  describe('только обрезка — поведение этапа 34 сохранено', () => {
    it('без ключа сервиса задача помечается пропущенной, а не падает', async () => {
      // Продукт работает как до этапа 34: ролик в родном формате Veo.
      const { svc, api } = build({ configured: false });
      const r = await svc.start('s1', VIDEO);
      expect(r.postStatus).toBe('skipped');
      expect(r.downloadUrl).toBe(VIDEO.downloadUrl);
      expect(api.submit).not.toHaveBeenCalled();
    });

    it('Е-2.7 шестого аудита: сервис не настроен, но субтитры заказаны — subtitlesMode/subtitleStatus не теряются', async () => {
      // Раньше этот ранний выход не проставлял ни subtitlesMode, ни
      // subtitleStatus, хотя work.subtitlesMode уже был посчитан как 'on'
      // — расхождение только в поле, объясняющем отсутствие субтитров.
      const { svc, sessions } = build({
        configured: false,
        session: session({
          brandManifestSnapshot: { voiceMode: 'veo', subtitlesMode: 'on' },
        }),
      });
      const r = await svc.start('s1', VIDEO);
      expect(r.postStatus).toBe('skipped');
      expect(r.subtitlesMode).toBe('on');
      expect(r.subtitleStatus).toBe('skipped');
      expect(sessions.updateSession).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({
          generatedVideo: expect.objectContaining({
            subtitlesMode: 'on',
            subtitleStatus: 'skipped',
          }),
        }),
      );
    });

    it('Е-2.7 шестого аудита: денежный лимит отказал, но субтитры заказаны — subtitlesMode/subtitleStatus не теряются', async () => {
      const { svc } = build({
        denied: 'дневной лимит расхода исчерпан',
        session: session({
          brandManifestSnapshot: { voiceMode: 'veo', subtitlesMode: 'on' },
        }),
      });
      const r = await svc.start('s1', VIDEO);
      expect(r.postStatus).toBe('skipped');
      expect(r.postError).toContain('лимит');
      expect(r.subtitlesMode).toBe('on');
      expect(r.subtitleStatus).toBe('skipped');
    });

    it('родной формат без озвучки не отправляется в задачу', async () => {
      const { svc, api } = build();
      const r = await svc.start('s1', { ...VIDEO, aspectRatio: '9:16' });
      expect(api.submit).not.toHaveBeenCalled();
      expect(r.reframePending).toBe(false);
      expect(r.postStatus).toBe('skipped');
    });

    it('запуск отправляет команду и записывает расход', async () => {
      const { svc, api, aiUsage } = build();
      const r = await svc.start('s1', VIDEO);
      const arg = api.submit.mock.calls[0][0];
      expect(arg.inputs.source).toBe(VIDEO.downloadUrl);
      expect(arg.commands[0]).toContain('crop=');
      expect(r.postStatus).toBe('pending');
      expect(r.postJobId).toBe('job1');
      expect(aiUsage.record).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'reframe', sessionId: 's1' }),
      );
    });

    it('в режиме veo синтез не вызывается вовсе', async () => {
      // Голос Veo — это отсутствие расхода на TTS, а не тихий вызов.
      const { svc, tts } = build();
      await svc.start('s1', VIDEO);
      expect(tts.synthesize).not.toHaveBeenCalled();
    });

    it('сбой отправки не роняет ответ — ролик у пользователя уже есть', async () => {
      const { svc, api } = build();
      api.submit.mockRejectedValue(new Error('502'));
      const r = await svc.start('s1', VIDEO);
      expect(r.postStatus).toBe('failed');
      expect(r.postError).toContain('502');
      expect(r.downloadUrl).toBe(VIDEO.downloadUrl);
    });

    it('повторный запуск не создаёт вторую задачу и второй счёт', async () => {
      const { svc, api } = build();
      await svc.start('s1', { ...VIDEO, postStatus: 'pending' as const });
      expect(api.submit).not.toHaveBeenCalled();
    });
  });

  describe('озвучка', () => {
    const voiced = session({
      brandManifestSnapshot: { voiceMode: 'voiceover', ttsVoiceId: 'brand-1' },
    });

    it('дорожка синтезируется, переносится к нам и уходит в ту же задачу', async () => {
      // Одна задача на обрезку и звук — иначе два счёта, два
      // перекодирования и гонка за порядок.
      const { svc, api, blob, tts } = build({ session: voiced });
      const r = await svc.start('s1', VIDEO);

      expect(tts.synthesize).toHaveBeenCalledWith(
        expect.objectContaining({ voiceId: 'brand-1' }),
      );
      expect(blob.uploadBuffer.mock.calls[0][0]).toBe(
        'sessions/s1/voiceover.mp3',
      );
      const arg = api.submit.mock.calls[0][0];
      expect(arg.inputs.voice).toBe(
        'https://blob.test/sessions/s1/voiceover.mp3',
      );
      expect(arg.commands[0]).toContain('amix');
      expect(arg.commands[0]).toContain('crop=');
      expect(api.submit).toHaveBeenCalledTimes(1);
      expect(r.voiceStatus).toBe('synthesized');
      expect(r.voiceMode).toBe('voiceover');
    });

    it('в синтез уходит текст без пометок о сценах', async () => {
      const { svc, tts } = build({
        session: session({
          brandManifestSnapshot: { voiceMode: 'voiceover' },
          generationPrompt: {
            finalVoiceoverScript:
              '- Scene 1 (0:00–0:01.5, female VO): "Это работает."',
          },
        }),
      });
      await svc.start('s1', VIDEO);
      expect(tts.synthesize.mock.calls[0][0].text).toBe('Это работает.');
    });

    it('расход считается в символах, а не в токенах', async () => {
      const { svc, aiUsage } = build({ session: voiced });
      await svc.start('s1', VIDEO);
      expect(aiUsage.record).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'voiceover',
          model: 'elevenlabs-tts',
          characters: 28,
        }),
      );
    });

    it('ключ модели в ai_usage берётся из активного провайдера, не захардкожен', async () => {
      // doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md, находка 6.1: раньше здесь
      // была строка 'elevenlabs-tts' буквально.
      const { svc, aiUsage } = build({
        session: voiced,
        ttsProviderKey: 'resemble',
      });
      await svc.start('s1', VIDEO);
      expect(aiUsage.record).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'resemble-tts' }),
      );
    });

    describe('явный тег провайдера голоса — этап 91 (было «рассинхрон провайдера», §4.2 doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md)', () => {
      const tagged = session({
        brandManifestSnapshot: {
          voiceMode: 'voiceover',
          ttsVoiceId: 'brand-1',
          ttsProvider: 'resemble',
        },
      });

      it('тег ≠ активный на стенде — синтез всё равно идёт ЧЕРЕЗ ТЕГ (resolveByKey), не через платформенный дефолт', async () => {
        // До этапа 91 это был сбой без сетевого вызова («защита от
        // обречённого платного вызова»). Явный выбор провайдера в
        // RevoicePanel сделал тег источником правды — voiceId пришёл из
        // каталога именно тегированного провайдера, вызов корректен.
        const { svc, tts, ttsResolver } = build({
          session: tagged,
          ttsProviderKey: 'elevenlabs', // активный на стенде — другой
        });
        const r = await svc.start('s1', VIDEO);
        expect(ttsResolver.resolveByKey).toHaveBeenCalledWith('resemble');
        expect(ttsResolver.resolve).not.toHaveBeenCalled();
        expect(tts.synthesize).toHaveBeenCalled();
        expect(r.voiceStatus).toBe('synthesized');
      });

      it('провайдер совпадает — синтез идёт как обычно (через resolveByKey, тот же результат)', async () => {
        const { svc, tts } = build({
          session: tagged,
          ttsProviderKey: 'resemble',
        });
        const r = await svc.start('s1', VIDEO);
        expect(tts.synthesize).toHaveBeenCalled();
        expect(r.voiceStatus).toBe('synthesized');
      });

      it('brand.ttsProvider не задан (старая запись) — читает АКТИВНЫЙ на стенде провайдер (resolve()), синтез идёт', async () => {
        const { svc, tts, ttsResolver } = build({ session: voiced }); // voiced: ttsProvider не задан
        const r = await svc.start('s1', VIDEO);
        expect(ttsResolver.resolve).toHaveBeenCalled();
        expect(ttsResolver.resolveByKey).not.toHaveBeenCalled();
        expect(tts.synthesize).toHaveBeenCalled();
        expect(r.voiceStatus).toBe('synthesized');
      });
    });

    it('ненастроенный синтез не отменяет обрезку', async () => {
      // Иначе ненастроенный необязательный сервис наказывал бы за себя
      // операцией, которая от него не зависит.
      const { svc, api, tts } = build({ session: voiced });
      tts.synthesize.mockResolvedValue({
        ok: false,
        skipped: true,
        reason: 'VOICE_API_KEY не задан',
      });
      const r = await svc.start('s1', VIDEO);
      expect(api.submit).toHaveBeenCalledTimes(1);
      expect(api.submit.mock.calls[0][0].commands[0]).toContain('crop=');
      expect(api.submit.mock.calls[0][0].commands[0]).not.toContain('amix');
      expect(r.voiceStatus).toBe('skipped');
      expect(r.postStatus).toBe('pending');
    });

    it('сбой синтеза отличается от пропуска', async () => {
      // Пропуск интерфейс показывает спокойной пометкой, сбой — причиной.
      const { svc } = build({ session: voiced });
      const { svc: s2, tts } = build({ session: voiced });
      tts.synthesize.mockResolvedValue({
        ok: false,
        skipped: false,
        reason: 'ElevenLabs 401',
      });
      expect((await svc.start('s1', VIDEO)).voiceStatus).toBe('synthesized');
      const r = await s2.start('s1', VIDEO);
      expect(r.voiceStatus).toBe('failed');
      expect(r.voiceError).toContain('401');
    });

    it('стёртые пользователем реплики побеждают текст от GPT', async () => {
      // Пользователь читает «пусто — ролик останется со звуком модели»,
      // стирает реплики и не должен получить ролик, озвученный ровно
      // тем, что он удалил (этап 37, А-2.5).
      const { svc, tts } = build({
        session: session({
          brandManifestSnapshot: { voiceMode: 'dub' },
          generationPrompt: {
            voiceoverScript: 'Текст, который написал GPT.',
            finalVoiceoverScript: '',
          },
        }),
      });
      const r = await svc.start('s1', VIDEO);
      expect(tts.synthesize).not.toHaveBeenCalled();
      expect(r.voiceStatus).toBe('skipped');
    });

    it('пустой текст озвучки — пропуск с внятной причиной', async () => {
      const { svc, tts } = build({
        session: session({
          brandManifestSnapshot: { voiceMode: 'voiceover' },
          generationPrompt: {},
        }),
      });
      const r = await svc.start('s1', VIDEO);
      expect(tts.synthesize).not.toHaveBeenCalled();
      expect(r.voiceStatus).toBe('skipped');
      expect(r.voiceError).toContain('текста озвучки нет');
    });

    it('голос сдвигается к первой реплике, а не стартует поверх крючка', async () => {
      // Таймкоды модель уже написала — сдвиг берётся из них и не стоит
      // ни одного лишнего вызова (§15.4, половина вопроса 15.2).
      const { svc, api } = build({
        session: session({
          brandManifestSnapshot: { voiceMode: 'voiceover' },
          generationPrompt: {
            finalVoiceoverScript:
              'Dialogue (timed to scenes):\n- Scene 2 (0:01.5–0:03.5): "Это работает."',
          },
        }),
      });
      await svc.start('s1', VIDEO);
      expect(api.submit.mock.calls[0][0].commands[0]).toContain(
        'adelay=1500:all=1',
      );
    });

    it('текст без таймкодов сдвига не даёт', async () => {
      const { svc, api } = build({ session: voiced });
      await svc.start('s1', VIDEO);
      expect(api.submit.mock.calls[0][0].commands[0]).not.toContain('adelay');
    });

    it('дубляж заменяет звук, а не подмешивает', async () => {
      const { svc, api } = build({
        session: session({ brandManifestSnapshot: { voiceMode: 'dub' } }),
      });
      await svc.start('s1', VIDEO);
      expect(api.submit.mock.calls[0][0].commands[0]).not.toContain('amix');
    });

    it('озвучка родного формата тоже идёт задачей — резать нечего, но звук нужен', async () => {
      const { svc, api } = build({ session: voiced });
      const r = await svc.start('s1', {
        ...VIDEO,
        aspectRatio: '9:16',
        reframePending: false,
      });
      const cmd = api.submit.mock.calls[0][0].commands[0];
      expect(cmd).toContain('amix');
      // Кадр не трогали — видео копируется потоком, без перекодирования.
      expect(cmd).toContain('-c:v copy');
      expect(r.postStatus).toBe('pending');
    });

    it('снимок без режима читается как «свой голос поверх» (15.09.2026)', async () => {
      // Раньше — «голос Veo» (данные до этапа 35); теперь умолчание одно
      // на всю систему, иначе «veo» просачивался через каждую точку без поля.
      const { svc, tts } = build({
        session: session({ brandManifestSnapshot: { title: 'бренд' } }),
      });
      const r = await svc.start('s1', VIDEO);
      expect(r.voiceMode).toBe('voiceover');
      expect(tts.synthesize).toHaveBeenCalled();
    });
  });

  describe('бюджет и блокировка (этап 38, А-2.15)', () => {
    it('заблокированному постобработка не делается, но ролик остаётся', () => {
      // Отказ здесь — пометка, а не исключение: ролик уже снят и отдан,
      // и уронить ответ значит показать ошибку вместо готового ролика.
      return build({ denied: 'Платные операции приостановлены: накрутка' })
        .svc.start('s1', VIDEO)
        .then((r) => {
          expect(r.postStatus).toBe('skipped');
          expect(r.postError).toContain('приостановлены');
          expect(r.downloadUrl).toBe(VIDEO.downloadUrl);
        });
    });

    it('отказ бюджета не тратит ни синтез, ни задачу, ни захват', async () => {
      const { svc, api, tts, sessions } = build({
        denied: 'Дневной лимит исчерпан',
        session: session({
          brandManifestSnapshot: { voiceMode: 'voiceover' },
        }),
      });
      await svc.start('s1', VIDEO);
      expect(tts.synthesize).not.toHaveBeenCalled();
      expect(api.submit).not.toHaveBeenCalled();
      expect(sessions.claimPostProduction).not.toHaveBeenCalled();
    });

    it('проверка идёт по владельцу сессии, а не по её id', async () => {
      const { svc, plans } = build();
      await svc.start('s1', VIDEO);
      expect(plans.assertCanSpendSession).toHaveBeenCalledWith('s1');
    });

    it('когда делать нечего, бюджет не спрашиваем', async () => {
      // Родной формат без озвучки не стоит ничего — незачем беспокоить
      // проверку и незачем отказывать заблокированному в том, что
      // бесплатно.
      const { svc, plans } = build({ denied: 'заблокирован' });
      const r = await svc.start('s1', { ...VIDEO, aspectRatio: '9:16' });
      expect(plans.assertCanSpendSession).not.toHaveBeenCalled();
      expect(r.postStatus).toBe('skipped');
    });
  });

  describe('захват работы (этап 37, А-2.2)', () => {
    it('проигравший захват не платит ни за синтез, ни за задачу', async () => {
      // Три опроса статуса доходят сюда одновременно; заплатить должен
      // ровно один.
      const { svc, api, tts, aiUsage } = build({
        claimed: false,
        session: session({
          brandManifestSnapshot: { voiceMode: 'voiceover' },
        }),
      });
      const r = await svc.start('s1', VIDEO);
      expect(api.submit).not.toHaveBeenCalled();
      expect(tts.synthesize).not.toHaveBeenCalled();
      expect(aiUsage.record).not.toHaveBeenCalled();
      // И состояние не трогает: его пишет тот, кто захват выиграл.
      expect(r).toBe(VIDEO);
    });

    it('захват идёт ПОСЛЕ решения, что работа нужна', async () => {
      // Занимать нечего, когда кадр родной и озвучка не заказана.
      const { svc, sessions } = build();
      await svc.start('s1', { ...VIDEO, aspectRatio: '9:16' });
      expect(sessions.claimPostProduction).not.toHaveBeenCalled();
    });

    it('ненастроенный сервис тоже не занимает работу', async () => {
      const { svc, sessions } = build({ configured: false });
      await svc.start('s1', VIDEO);
      expect(sessions.claimPostProduction).not.toHaveBeenCalled();
    });

    it('выигравший захват доводит дело до задачи', async () => {
      const { svc, api, sessions } = build();
      const r = await svc.start('s1', VIDEO);
      expect(sessions.claimPostProduction).toHaveBeenCalledWith('s1');
      expect(api.submit).toHaveBeenCalledTimes(1);
      expect(r.postJobId).toBe('job1');
    });
  });

  describe('субтитры (этап 67)', () => {
    const subtitled = (voiceMode: 'veo' | 'voiceover' | 'dub' = 'veo') =>
      session({
        brandManifestSnapshot: { voiceMode, subtitlesMode: 'on' },
        generationPrompt: {
          finalVoiceoverScript: 'Это работает. Берите сейчас.',
        },
      });

    it('subtitlesMode: off (но кроп нужен) — сборка субтитров не вызывается', async () => {
      // Субтитры выключены у бренда, но кадр всё равно режется — задача
      // ffmpeg уходит, просто без .srt в списке загрузок и без пометки
      // subtitleStatus (она проставляется только внутри сборки — тот же
      // принцип, что у voiceStatus в режиме veo без синтеза).
      const { svc, api, blob } = build({
        session: session({ brandManifestSnapshot: { voiceMode: 'veo' } }),
      });
      const r = await svc.start('s1', VIDEO);
      expect(r.subtitleStatus).toBeUndefined();
      expect(
        blob.uploadBuffer.mock.calls.some((c: unknown[]) =>
          String(c[0]).endsWith('subtitles.srt'),
        ),
      ).toBe(false);
      expect(api.submit.mock.calls[0][0].commands[0]).not.toContain(
        'subtitles=',
      );
    });

    it('ни кропа, ни голоса, ни субтитров — ранний пропуск помечает всё сразу', async () => {
      // Единственный путь, где subtitleStatus проставляется без вызова
      // buildSubtitles — фиксируем его отдельно от «сборка не удалась».
      const { svc, api } = build({
        session: session({ brandManifestSnapshot: { voiceMode: 'veo' } }),
      });
      const r = await svc.start('s1', { ...VIDEO, aspectRatio: '9:16' });
      expect(api.submit).not.toHaveBeenCalled();
      expect(r.postStatus).toBe('skipped');
      expect(r.subtitleStatus).toBe('skipped');
    });

    it('veo + subtitlesMode: on — эвристика без вызова TTS', async () => {
      // Veo сам озвучивает по репликам из промпта — отдельного вызова
      // синтеза для субтитров быть не должно, только для голоса.
      const { svc, api, tts, blob } = build({ session: subtitled('veo') });
      const r = await svc.start('s1', VIDEO);
      expect(tts.synthesize).not.toHaveBeenCalled();
      expect(blob.uploadBuffer.mock.calls[0][0]).toBe(
        'sessions/s1/subtitles.srt',
      );
      expect(r.subtitleStatus).toBe('burned');
      expect(api.submit.mock.calls[0][0].inputs.subs).toBe(
        'https://blob.test/sessions/s1/subtitles.srt',
      );
      expect(api.submit.mock.calls[0][0].commands[0]).toContain('subtitles=');
    });

    // Доп. запрос владельца продукта (ТЗ §9, этап 4 плана §14) — найдено
    // при аудите: до исправления эвристика тайминга субтитров получала
    // жёстко зашитые 8 секунд независимо от реальной длины ролика —
    // для цепочки Scene Extension субтитры сжимались бы в первые 8
    // секунд, а не растягивались на весь ролик.
    it('veo + цепочка Scene Extension — субтитры считаются на реальную длину, не на 8 секунд', async () => {
      const { svc, blob } = build({
        session: subtitled('veo'),
      });
      const longVideo: GeneratedVideo = {
        ...VIDEO,
        chainSegmentsDone: 3,
        chainSegmentsTotal: 3,
        chainTargetDurationSeconds: 24,
      };
      await svc.start('s1', longVideo);

      const srtCall = blob.uploadBuffer.mock.calls.find((c: unknown[]) =>
        String(c[0]).endsWith('subtitles.srt'),
      );
      expect(srtCall).toBeDefined();
      const srtText = (srtCall![1] as Buffer).toString('utf-8');
      // Последняя реплика должна заканчиваться близко к реальным 24
      // секундам — метка за пределами ~9 секунд в принципе невозможна
      // при старом (жёстко зашитом на 8) поведении, это и есть прямая
      // проверка находки.
      expect(srtText).toMatch(/00:00:2[0-4],\d{3}/);
    });

    it('voiceover + subtitlesMode: on — timestamps: true передан в TTS', async () => {
      const { svc, tts } = build({
        session: subtitled('voiceover'),
      });
      await svc.start('s1', VIDEO);
      expect(tts.synthesize).toHaveBeenCalledWith(
        expect.objectContaining({ timestamps: true }),
      );
    });

    it('voiceover + subtitlesMode: off — timestamps не запрашивается', async () => {
      // Лишний JSON-конверт вместо сырых байт — накладной расход там, где
      // субтитры выключены.
      const { svc, tts } = build({
        session: session({
          brandManifestSnapshot: { voiceMode: 'voiceover' },
        }),
      });
      await svc.start('s1', VIDEO);
      expect(tts.synthesize).toHaveBeenCalledWith(
        expect.objectContaining({ timestamps: false }),
      );
    });

    it('voiceover + on — реальный тайминг из alignment ложится в .srt', async () => {
      const { svc, tts, blob } = build({ session: subtitled('voiceover') });
      tts.synthesize.mockResolvedValue({
        ok: true,
        audio: Buffer.from([1]),
        mimeType: 'audio/mpeg',
        characters: 28,
        voiceId: 'voice-1',
        model: 'eleven_multilingual_v2',
        alignment: {
          characters: [...'это работает. берите сейчас.'],
          starts: [...'это работает. берите сейчас.'].map((_, i) => i * 0.1),
          ends: [...'это работает. берите сейчас.'].map(
            (_, i) => i * 0.1 + 0.1,
          ),
        },
      });
      const r = await svc.start('s1', VIDEO);
      expect(r.subtitleStatus).toBe('burned');
      const srtCall = blob.uploadBuffer.mock.calls.find((c: unknown[]) =>
        String(c[0]).endsWith('subtitles.srt'),
      );
      expect(srtCall).toBeDefined();
      const srt = (srtCall![1] as Buffer).toString('utf8');
      expect(srt).toContain('-->');
      expect(srt).toContain('Это работает.');
    });

    it('провал сборки .srt не отменяет ни кроп, ни звук', async () => {
      // То же «ухудшение, а не поломка», что и у голоса: задача уходит
      // без субтитрового фильтра, но кроп и звук остаются.
      const { svc, api, blob } = build({ session: subtitled('veo') });
      blob.uploadBuffer.mockImplementation((pathname: string) =>
        pathname.endsWith('subtitles.srt')
          ? Promise.reject(new Error('blob недоступен'))
          : Promise.resolve({ url: `https://blob.test/${pathname}` }),
      );
      const r = await svc.start('s1', VIDEO);
      expect(r.subtitleStatus).toBe('failed');
      expect(r.postStatus).toBe('pending');
      expect(api.submit).toHaveBeenCalledTimes(1);
      expect(api.submit.mock.calls[0][0].commands[0]).not.toContain(
        'subtitles=',
      );
      expect(api.submit.mock.calls[0][0].commands[0]).toContain('crop=');
    });

    it('пустой текст — subtitleStatus: skipped с внятной причиной', async () => {
      const { svc, tts } = build({
        session: session({
          brandManifestSnapshot: { voiceMode: 'veo', subtitlesMode: 'on' },
          generationPrompt: {},
        }),
      });
      const r = await svc.start('s1', VIDEO);
      expect(tts.synthesize).not.toHaveBeenCalled();
      expect(r.subtitleStatus).toBe('skipped');
      expect(r.subtitleError).toContain('текста для субтитров нет');
    });

    it('родной формат без голоса, но с субтитрами — задача всё равно уходит', async () => {
      // Раньше «нечего делать» проверялось только по кропу и голосу;
      // субтитры сами по себе обязаны запускать задачу.
      const { svc, api } = build({
        session: session({
          brandManifestSnapshot: { voiceMode: 'veo', subtitlesMode: 'on' },
        }),
      });
      const r = await svc.start('s1', {
        ...VIDEO,
        aspectRatio: '9:16',
        reframePending: false,
      });
      expect(api.submit).toHaveBeenCalledTimes(1);
      expect(api.submit.mock.calls[0][0].commands[0]).toContain('subtitles=');
      expect(r.postStatus).toBe('pending');
    });
  });

  describe('опрос задачи', () => {
    const pending = {
      ...VIDEO,
      postStatus: 'pending' as const,
      postJobId: 'job1',
      // Свежий старт: дедлайн постобработки (этап 52) считается от него.
      postStartedAt: new Date(),
    };

    it('задача старше дедлайна закрывается сбоем, провайдер не опрашивается (В-2.7)', async () => {
      // Незнакомый статус провайдера читался как «идёт», любая ошибка
      // опроса — как «оставляем как есть»: клиент опрашивал бесконечно, а
      // аудит не отпускал никогда.
      const { svc, api, sessions } = build();
      const stale = {
        ...pending,
        postStartedAt: new Date(Date.now() - POSTPROD_DEADLINE_MS - 1000),
      };
      const r = await svc.poll('s1', stale);
      expect(r.postStatus).toBe('failed');
      expect(r.postError).toMatch(/не завершилась/);
      // Ролик у пользователя остаётся: постобработка — ухудшение, не поломка.
      expect(r.downloadUrl).toBe(VIDEO.downloadUrl);
      expect(api.status).not.toHaveBeenCalled();
      expect(sessions.updateSession).toHaveBeenCalled();
    });

    it('запись без postStartedAt (до этапа 52) судится от старта рендера с запасом', () => {
      const old = { initiatedAt: new Date(Date.now() - 36 * 60 * 1000) };
      expect(postProductionExpired(old)).toBe(true);
      expect(
        postProductionExpired({
          initiatedAt: new Date(Date.now() - 20 * 60 * 1000),
        }),
      ).toBe(false);
      // Строка из JSON — тоже дата.
      expect(
        postProductionExpired({
          initiatedAt: new Date(),
          postStartedAt: new Date(
            Date.now() - POSTPROD_DEADLINE_MS - 1,
          ).toISOString() as never,
        }),
      ).toBe(true);
    });

    it('сетевая икота до дедлайна оставляет задачу идущей', async () => {
      const { svc, api } = build();
      api.status.mockRejectedValue(new Error('ECONNRESET'));
      const r = await svc.poll('s1', pending);
      expect(r).toBe(pending);
    });

    it('пока задача идёт, состояние не меняется', async () => {
      const { svc, sessions } = build();
      const r = await svc.poll('s1', pending);
      expect(r).toBe(pending);
      expect(sessions.updateSession).not.toHaveBeenCalled();
    });

    it('готовая задача переносит файл к нам и подменяет ссылку', async () => {
      const { svc, api, blob } = build();
      api.status.mockResolvedValue({
        status: 'completed',
        outputs: { 'final.mp4': 'https://ffmpeg.test/out.mp4' },
      });
      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      });

      const r = await svc.poll('s1', pending);

      // Чужая ссылка живёт ограниченное время — отдавать её пользователю
      // значит через сутки получить битую.
      expect(blob.uploadBuffer.mock.calls[0][0]).toBe(
        'sessions/s1/generated-4x5.mp4',
      );
      expect(r.postStatus).toBe('complete');
      expect(r.reframePending).toBe(false);
      expect(r.downloadUrl).toBe(
        'https://blob.test/sessions/s1/generated-4x5.mp4',
      );
      // Исходник остаётся — как страховка и для сравнения «до и после».
      expect(r.renderedUrl).toBe(VIDEO.downloadUrl);
      expect(r.postPathname).toBe('sessions/s1/generated-4x5.mp4');
    });

    it('озвучка без обрезки кладётся по своему пути', async () => {
      // Два разных результата не должны делить один путь в хранилище.
      const { svc, api, blob } = build();
      api.status.mockResolvedValue({
        status: 'completed',
        outputs: { 'final.mp4': 'https://ffmpeg.test/out.mp4' },
      });
      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      });
      await svc.poll('s1', { ...pending, reframePending: false });
      expect(blob.uploadBuffer.mock.calls[0][0]).toBe(
        'sessions/s1/generated-voiced.mp4',
      );
    });

    it('упавшая задача оставляет исходный ролик рабочим', async () => {
      const { svc, api } = build();
      api.status.mockResolvedValue({ status: 'failed', error: 'bad filter' });
      const r = await svc.poll('s1', pending);
      expect(r.postStatus).toBe('failed');
      expect(r.postError).toBe('bad filter');
      expect(r.downloadUrl).toBe(VIDEO.downloadUrl);
    });

    it('завершение без файла — тоже отказ, а не тихий успех', async () => {
      const { svc, api } = build();
      api.status.mockResolvedValue({ status: 'completed', outputs: undefined });
      const r = await svc.poll('s1', pending);
      expect(r.postStatus).toBe('failed');
      expect(r.reframePending).toBe(true);
    });

    it('захват без задачи закрывается сбоем, а не вечным «обрезаем…»', async () => {
      // Процесс умер между захватом и отправкой (на Vercel — таймаут
      // функции). Оставить как есть значит «обрезаем» навсегда.
      const { svc, api } = build();
      const r = await svc.poll('s1', {
        ...VIDEO,
        postStatus: 'pending',
        postJobId: undefined,
      });
      expect(api.status).not.toHaveBeenCalled();
      expect(r.postStatus).toBe('failed');
      expect(r.postError).toContain('не запустилась');
      expect(r.downloadUrl).toBe(VIDEO.downloadUrl);
    });

    it('недоступный статус не меняет состояние — следующий опрос повторит', async () => {
      const { svc, api, sessions } = build();
      api.status.mockRejectedValue(new Error('ETIMEDOUT'));
      expect(await svc.poll('s1', pending)).toBe(pending);
      expect(sessions.updateSession).not.toHaveBeenCalled();
    });
  });

  describe('автоэкспорт, ярус A (TODO §35, этап 75)', () => {
    it('не готовый ролик — отказ, автоэкспорт только для готового', async () => {
      const { svc } = build();
      await expect(
        svc.startExport(
          's1',
          { ...VIDEO, status: GenerationStatus.PROCESSING },
          ['1:1'],
        ),
      ).rejects.toThrow('автоэкспорт доступен только для готового ролика');
    });

    it('сервис не настроен — отказ, а не тихий пропуск', async () => {
      // В отличие от `start()`, это явное платное действие пользователя —
      // отказ должен дойти до него, не раствориться.
      const { svc } = build({ configured: false });
      await expect(svc.startExport('s1', VIDEO, ['1:1'])).rejects.toThrow(
        'автоэкспорт недоступен',
      );
    });

    it('формат из другого семейства — отказ с явной подсказкой на /export/rerender', async () => {
      // VIDEO отрендерен в 9:16 (renderedAspectRatio) — 16:9 из другого
      // семейства кадра, дёшево не обрезать.
      const { svc } = build();
      await expect(svc.startExport('s1', VIDEO, ['16:9'])).rejects.toThrow(
        '/export/rerender',
      );
    });

    it('уже есть такой же формат — второй раз не запрашивается, пустой список после фильтра — отказ', async () => {
      const { svc } = build();
      await expect(
        svc.startExport('s1', { ...VIDEO, aspectRatio: '4:5' }, ['4:5']),
      ).rejects.toThrow('нет новых форматов');
    });

    it('предыдущий батч ещё выполняется — отказ, дождаться завершения', async () => {
      const { svc } = build();
      const withPending: GeneratedVideo = {
        ...VIDEO,
        exportVariants: [
          { format: '1:1', tier: 'A', status: 'pending', requestedAt: 'x' },
        ],
      };
      await expect(svc.startExport('s1', withPending, ['3:4'])).rejects.toThrow(
        'ещё выполняется',
      );
    });

    it('план запрещает трату (лимит/блокировка) — бросает, задача не отправляется', async () => {
      const { svc, api } = build({ denied: 'дневной лимit исчерпан' });
      await expect(svc.startExport('s1', VIDEO, ['1:1'])).rejects.toThrow(
        'дневной лимit исчерпан',
      );
      expect(api.submit).not.toHaveBeenCalled();
    });

    it('несколько форматов ОДНОГО семейства — один batched submit, один billing-record', async () => {
      // VIDEO.aspectRatio уже '4:5' — берём другие два формата того же
      // семейства (9:16), чтобы оба реально попали в батч.
      const { svc, api, aiUsage, sessions } = build();
      const r = await svc.startExport('s1', VIDEO, ['1:1', '3:4']);
      expect(api.submit).toHaveBeenCalledTimes(1);
      const call = api.submit.mock.calls[0][0];
      expect(call.outputs.length).toBe(2);
      expect(call.commands.length).toBe(2);
      expect(aiUsage.record).toHaveBeenCalledTimes(1);
      expect(aiUsage.record).toHaveBeenCalledWith({
        operation: 'reframe',
        model: 'ffmpeg-api',
        sessionId: 's1',
      });
      expect(r.exportJobId).toBe('job1');
      expect(r.exportVariants).toHaveLength(2);
      expect(
        r.exportVariants!.every(
          (v) => v.tier === 'A' && v.status === 'pending',
        ),
      ).toBe(true);
      expect(sessions.updateSession).toHaveBeenCalledTimes(1);
    });

    it('Е-2.1 шестого аудита: замок занят параллельным запросом — отказ, api.submit не вызывается, замок освобождается', async () => {
      const { svc, api, sessions } = build({ exportClaimed: false });
      await expect(svc.startExport('s1', VIDEO, ['1:1'])).rejects.toThrow(
        'уже выполняется',
      );
      expect(api.submit).not.toHaveBeenCalled();
      // Замок не был захвачен нами — освобождать нечего.
      expect(sessions.releaseWork).not.toHaveBeenCalled();
    });

    it('Е-2.1: замок захвачен и освобождён вокруг платного вызова, даже при отказе плана', async () => {
      const { svc, sessions } = build({ denied: 'лимит' });
      await expect(svc.startExport('s1', VIDEO, ['1:1'])).rejects.toThrow(
        'лимит',
      );
      expect(sessions.claimWork).toHaveBeenCalledWith(
        's1',
        'export',
        expect.any(Number),
      );
      expect(sessions.releaseWork).toHaveBeenCalledWith('s1', 'export');
    });

    it('Е-2.1: свежее чтение под замком видит уже начатый параллельным запросом батч — второй запрос отказывает, не платит дважды', async () => {
      // Снимок video (стартовая проверка вызывающего кода) ещё «чистый»,
      // но session.getSession под замком уже видит pending-вариант,
      // который успел записать параллельный (первый) запрос.
      const { svc, api } = build({
        session: {
          ...session(),
          generatedVideo: {
            ...VIDEO,
            exportVariants: [
              { format: '1:1', tier: 'A', status: 'pending', requestedAt: 'x' },
            ],
          },
        },
      });
      await expect(svc.startExport('s1', VIDEO, ['3:4'])).rejects.toThrow(
        'ещё выполняется',
      );
      expect(api.submit).not.toHaveBeenCalled();
    });
  });

  describe('автоэкспорт, опрос яруса A (pollExport, этап 75)', () => {
    const withPendingA = (
      extra: Partial<ExportVariant> = {},
    ): GeneratedVideo => ({
      ...VIDEO,
      exportJobId: 'job1',
      exportVariants: [
        {
          format: '4:5',
          tier: 'A',
          status: 'pending',
          outputName: 'export-4x5.mp4',
          requestedAt: 'x',
          ...extra,
        },
      ],
    });

    it('нет задачи или нет ожидающих вариантов — возвращает видео без изменений', async () => {
      const { svc, api } = build();
      const v = await svc.pollExport('s1', VIDEO);
      expect(v).toBe(VIDEO);
      expect(api.status).not.toHaveBeenCalled();
    });

    it('задача ещё выполняется — без изменений', async () => {
      const { svc, api } = build();
      api.status.mockResolvedValue({ status: 'pending' });
      const video = withPendingA();
      expect(await svc.pollExport('s1', video)).toBe(video);
    });

    it('недоступный статус — без изменений, следующий опрос повторит', async () => {
      const { svc, api, sessions } = build();
      api.status.mockRejectedValue(new Error('ETIMEDOUT'));
      const video = withPendingA();
      expect(await svc.pollExport('s1', video)).toBe(video);
      expect(sessions.updateSession).not.toHaveBeenCalled();
    });

    it('задача упала целиком — все ожидающие варианты помечаются failed', async () => {
      const { svc, api } = build();
      api.status.mockResolvedValue({ status: 'failed', error: 'bad filter' });
      const video = withPendingA();
      const r = await svc.pollExport('s1', video);
      expect(r.exportVariants![0].status).toBe('failed');
      expect(r.exportVariants![0].error).toBe('bad filter');
    });

    it('готово — файл скачан и перенесён в свой Blob, вариант complete', async () => {
      const { svc, api, blob } = build();
      api.status.mockResolvedValue({
        status: 'completed',
        outputs: { 'export-4x5.mp4': 'https://ffmpeg.test/out-4x5.mp4' },
      });
      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      });
      const video = withPendingA();
      const r = await svc.pollExport('s1', video);
      expect(r.exportVariants![0].status).toBe('complete');
      expect(r.exportVariants![0].url).toBe(
        'https://blob.test/sessions/s1/export-4x5.mp4',
      );
      expect(blob.uploadBuffer.mock.calls[0][0]).toBe(
        'sessions/s1/export-4x5.mp4',
      );
    });

    it('готово, но для этого варианта нет файла в ответе — вариант failed, остальные не трогает', async () => {
      const { svc, api } = build();
      api.status.mockResolvedValue({
        status: 'completed',
        outputs: {}, // outputName из варианта отсутствует
      });
      const video = withPendingA();
      const r = await svc.pollExport('s1', video);
      expect(r.exportVariants![0].status).toBe('failed');
      expect(r.exportVariants![0].error).toContain('файла для этого формата');
    });

    it('скачивание падает — вариант failed с текстом ошибки, не бросает наружу', async () => {
      const { svc, api } = build();
      api.status.mockResolvedValue({
        status: 'completed',
        outputs: { 'export-4x5.mp4': 'https://ffmpeg.test/out-4x5.mp4' },
      });
      (global as any).fetch = jest
        .fn()
        .mockResolvedValue({ ok: false, status: 502 });
      const video = withPendingA();
      const r = await svc.pollExport('s1', video);
      expect(r.exportVariants![0].status).toBe('failed');
      expect(r.exportVariants![0].error).toContain('502');
    });

    it('уже завершённые варианты не трогает второй раз', async () => {
      const { svc, api } = build();
      api.status.mockResolvedValue({ status: 'completed', outputs: {} });
      const video = withPendingA({
        status: 'complete',
        url: 'https://blob.test/x.mp4',
      });
      const r = await svc.pollExport('s1', video);
      expect(r.exportVariants![0]).toEqual(video.exportVariants![0]);
    });

    it('Е-2.2 шестого аудита: задача выполняется дольше дедлайна — закрывается сбоем, а не «ещё выполняется» навсегда', async () => {
      const { svc, api } = build();
      api.status.mockResolvedValue({ status: 'pending' });
      const longAgo = new Date(
        Date.now() - 20 * 60 * 1000, // 20 мин > EXPORT_DEADLINE_MS (15 мин)
      ).toISOString();
      const video = withPendingA({ requestedAt: longAgo });
      const r = await svc.pollExport('s1', video);
      expect(r.exportVariants![0].status).toBe('failed');
      expect(r.exportVariants![0].error).toContain('отведённое время');
    });

    it('Е-2.2: задача выполняется в пределах дедлайна — без изменений, замок не берётся', async () => {
      const { svc, api, sessions } = build();
      api.status.mockResolvedValue({ status: 'pending' });
      const recent = new Date(Date.now() - 60_000).toISOString();
      const video = withPendingA({ requestedAt: recent });
      expect(await svc.pollExport('s1', video)).toBe(video);
      expect(sessions.claimWork).not.toHaveBeenCalled();
    });

    it('Е-2.1: замок занят параллельным опросом — возвращает video без изменений, не роняет вызов', async () => {
      const { svc, api, sessions } = build({ exportClaimed: false });
      api.status.mockResolvedValue({
        status: 'completed',
        outputs: { 'export-4x5.mp4': 'https://ffmpeg.test/out-4x5.mp4' },
      });
      const video = withPendingA();
      const r = await svc.pollExport('s1', video);
      expect(r).toBe(video);
      expect(sessions.updateSession).not.toHaveBeenCalled();
    });

    it('Е-2.1: свежее чтение под замком видит, что параллельный опрос уже обработал результат — не пишет повторно', async () => {
      const { svc, api, sessions } = build({
        session: {
          ...session(),
          // Под замком варианты уже не pending — другой опрос успел
          // забрать результат первым.
          generatedVideo: withPendingA({ status: 'complete' }),
        },
      });
      api.status.mockResolvedValue({
        status: 'completed',
        outputs: { 'export-4x5.mp4': 'https://ffmpeg.test/out-4x5.mp4' },
      });
      const video = withPendingA();
      const r = await svc.pollExport('s1', video);
      expect(sessions.updateSession).not.toHaveBeenCalled();
      expect(r.exportVariants![0].status).toBe('complete');
    });
  });

  describe('reVoice — переозвучка готового ролика без перегенерации (этап 87)', () => {
    const DONE_VIDEO: GeneratedVideo = {
      ...VIDEO,
      status: GenerationStatus.COMPLETE,
      postStatus: 'complete',
      // После первого прохода постобработки исходник — уже здесь
      // (`poll()` переносит его сюда), `downloadUrl` — уже ГОТОВЫЙ файл
      // со старым голосом.
      renderedUrl: 'https://blob.test/sessions/s1/generated.mp4',
      downloadUrl: 'https://blob.test/sessions/s1/generated-4x5.mp4',
      reframePending: false, // одноразовый флаг уже снят первым проходом
    };
    const voiced = session({
      brandManifestSnapshot: { voiceMode: 'voiceover', ttsVoiceId: 'brand-1' },
    });

    it('видео с голосом Veo — переозвучивать нечего, отдельной дорожки нет', async () => {
      const { svc } = build({ session: session() /* voiceMode: 'veo' */ });
      await expect(svc.reVoice('s1', DONE_VIDEO)).rejects.toThrow(
        /голос ведёт сама Veo/,
      );
    });

    it('ролик ещё не готов — переозвучка отказывает сразу, не занимая замок', async () => {
      const { svc, sessions } = build({ session: voiced });
      await expect(
        svc.reVoice('s1', {
          ...DONE_VIDEO,
          status: GenerationStatus.PROCESSING,
        }),
      ).rejects.toThrow(/ещё не готов/);
      expect(sessions.claimWork).not.toHaveBeenCalled();
    });

    it('постобработка уже выполняется — отказ без повторного запуска', async () => {
      const { svc, sessions } = build({ session: voiced });
      await expect(
        svc.reVoice('s1', { ...DONE_VIDEO, postStatus: 'pending' }),
      ).rejects.toThrow(/уже выполняется/);
      expect(sessions.claimWork).not.toHaveBeenCalled();
    });

    it('замок занят параллельной переозвучкой — отказ, а не тихий no-op', async () => {
      const { svc, sessions } = build({
        session: voiced,
        exportClaimed: false, // build() один флаг на все claimWork-замки
      });
      await expect(svc.reVoice('s1', DONE_VIDEO)).rejects.toThrow(
        /уже запущена/,
      );
      expect(sessions.getSession).not.toHaveBeenCalled();
    });

    it('источник для ffmpeg — renderedUrl (сырой файл), а НЕ downloadUrl (уже с прежним голосом)', async () => {
      const { svc, api } = build({ session: voiced });
      await svc.reVoice('s1', DONE_VIDEO);
      expect(api.submit.mock.calls[0][0].inputs.source).toBe(
        DONE_VIDEO.renderedUrl,
      );
    });

    it('renderedUrl ещё нет (первой постобработки не было) — используется downloadUrl', async () => {
      const { svc, api } = build({ session: voiced });
      const noRendered = { ...DONE_VIDEO, renderedUrl: undefined };
      await svc.reVoice('s1', noRendered);
      expect(api.submit.mock.calls[0][0].inputs.source).toBe(
        noRendered.downloadUrl,
      );
    });

    it('крой определяется заново по aspectRatio/NATIVE, а не по устаревшему reframePending', async () => {
      // reframePending уже false (первый проход его снял), но формат
      // всё ещё некоренной для Veo — кроить нужно на каждом проходе.
      const { svc, api } = build({ session: voiced });
      await svc.reVoice('s1', DONE_VIDEO);
      expect(api.submit.mock.calls[0][0].commands[0]).toContain('crop=');
    });

    it('новый текст реплик перезаписывает finalVoiceoverScript ДО синтеза и уходит в TTS', async () => {
      const { svc, sessions, tts } = build({ session: voiced });
      await svc.reVoice('s1', DONE_VIDEO, {
        voiceoverScript: 'Новый текст для дубляжа.',
      });
      expect(sessions.updateSession).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({
          generationPrompt: expect.objectContaining({
            finalVoiceoverScript: 'Новый текст для дубляжа.',
            voiceoverScriptEdited: 'Новый текст для дубляжа.',
          }),
        }),
      );
      expect(tts.synthesize.mock.calls[0][0].text).toBe(
        'Новый текст для дубляжа.',
      );
    });

    it('без overrides.voiceoverScript — текст не трогается, идёт прежний', async () => {
      const { svc, sessions, tts } = build({ session: voiced });
      await svc.reVoice('s1', DONE_VIDEO);
      expect(sessions.updateSession).not.toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ generationPrompt: expect.anything() }),
      );
      expect(tts.synthesize.mock.calls[0][0].text).toBe(
        'Это работает. Берите сейчас.',
      );
    });

    it('бюджет проверяется ДО синтеза — отказ тарифа не оплачивает TTS', async () => {
      const { svc, tts } = build({
        session: voiced,
        denied: 'дневной лимит исчерпан',
      });
      await expect(svc.reVoice('s1', DONE_VIDEO)).rejects.toThrow(
        /дневной лимит исчерпан/,
      );
      expect(tts.synthesize).not.toHaveBeenCalled();
    });

    it('синтез не удался — переозвучка падает явно, а не молча оставляет старый ролик', async () => {
      const { svc, tts } = build({ session: voiced });
      tts.synthesize.mockResolvedValueOnce({
        ok: false,
        skipped: false,
        reason: 'провайдер синтеза недоступен',
      });
      await expect(svc.reVoice('s1', DONE_VIDEO)).rejects.toThrow(
        /провайдер синтеза недоступен/,
      );
    });

    it('успех — postStatus снова pending с новым postJobId, тем же путём подхватывается общим poll()', async () => {
      const { svc, api } = build({ session: voiced });
      const r = await svc.reVoice('s1', DONE_VIDEO);
      expect(r.postStatus).toBe('pending');
      expect(r.postJobId).toBe('job1');
      expect(r.postError).toBeUndefined();
      expect(api.submit).toHaveBeenCalledTimes(1);
    });

    it('замок снимается в finally — и при успехе, и при отказе', async () => {
      const { svc, sessions } = build({ session: voiced, denied: 'нет денег' });
      await expect(svc.reVoice('s1', DONE_VIDEO)).rejects.toThrow();
      expect(sessions.releaseWork).toHaveBeenCalledWith('s1', 'revoice');

      const ok = build({ session: voiced });
      await ok.svc.reVoice('s1', DONE_VIDEO);
      expect(ok.sessions.releaseWork).toHaveBeenCalledWith('s1', 'revoice');
    });
  });
});
