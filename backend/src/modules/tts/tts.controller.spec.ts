/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ForbiddenException } from '@nestjs/common';
import { PREVIEWS_PER_DAY, TtsController } from './tts.controller';

const req = { telegramUserId: 'u1' } as any;

function build(
  over: { configured?: boolean; used?: number; blocked?: boolean } = {},
) {
  const tts = {
    providerKey: 'elevenlabs',
    configured: jest.fn().mockReturnValue(over.configured ?? true),
    voices: jest.fn().mockResolvedValue({ voices: [] }),
    synthesize: jest.fn().mockResolvedValue({
      ok: true,
      audio: Buffer.from([1, 2, 3]),
      mimeType: 'audio/mpeg',
      characters: 12,
      voiceId: 'v1',
      model: 'eleven_multilingual_v2',
    }),
  };
  const plans = {
    assertCanSpendUser: jest
      .fn()
      .mockImplementation(() =>
        over.blocked
          ? Promise.reject(new ForbiddenException('заблокирован'))
          : Promise.resolve(),
      ),
  };
  const aiUsage = {
    countToday: jest.fn().mockResolvedValue(over.used ?? 0),
    record: jest.fn(),
  };
  const prisma = {
    userVoice: { findMany: jest.fn().mockResolvedValue([]) },
  };
  // Найдено при доп. запросе (добавление явного выбора провайдера,
  // resolveByKey): этот мок был написан ДО рефакторинга на
  // `TtsProviderResolverService` (см. её доккомментарий — «было:
  // статическая фабрика») и передавал сам `tts` первым аргументом
  // конструктора как если бы он и был резолвером — `as any` скрывал
  // несовпадение типов, но `this.ttsResolver.resolve()` у реального
  // объекта без метода `resolve()` упал бы `TypeError` в рантайме.
  // Обёрнуто в настоящий мок резолвера — `resolve()`/`resolveByKey()`
  // оба возвращают тот же `tts`, раз в этих тестах не важно, какой
  // именно ключ запросили.
  const ttsResolver = {
    resolve: jest.fn().mockResolvedValue(tts),
    resolveByKey: jest.fn().mockReturnValue(tts),
  };
  const analysis = {
    extractOriginalDialogueSample: jest.fn().mockResolvedValue(null),
  };
  return {
    ctl: new TtsController(
      ttsResolver as any,
      plans as any,
      aiUsage as any,
      prisma as any,
      analysis as any,
    ),
    tts,
    ttsResolver,
    plans,
    aiUsage,
    prisma,
    analysis,
  };
}

describe('TtsController (ТЗ §15.3)', () => {
  describe('каталог голосов', () => {
    it('ненастроенный синтез — не 500, а честное состояние', async () => {
      // Пустой список без объяснения оператор прочитает как поломку.
      const { ctl, tts } = build({ configured: false });
      const r = await ctl.voices();
      expect(r).toMatchObject({ configured: false, voices: [] });
      expect(r.error).toContain('не подключена');
      expect(tts.voices).not.toHaveBeenCalled();
    });

    it('настроенный отдаёт список провайдера и машинное имя активного провайдера', async () => {
      const { ctl, tts } = build();
      tts.voices.mockResolvedValue({
        voices: [{ voiceId: 'a', name: 'Аня', previewUrl: null, accent: null }],
      });
      const r = await ctl.voices('ru');
      expect(r.configured).toBe(true);
      expect(r.voices).toHaveLength(1);
      expect(r.provider).toBe('elevenlabs');
      expect(tts.voices).toHaveBeenCalledWith('ru');
    });

    it('provider в ответе отражает активный провайдер, даже когда синтез не настроен', async () => {
      const { ctl } = build({ configured: false });
      const r = await ctl.voices();
      expect(r.provider).toBe('elevenlabs');
    });

    it('клонированные пользователями голоса не попадают в общий каталог (этап 73)', async () => {
      // Resemble отдаёт /voices НА ВЕСЬ аккаунт — один RESEMBLE_API_KEY на
      // всех подписчиков. Без фильтра клон одного пользователя со своей
      // личной подписью светился бы в каталоге всех остальных.
      const { ctl, tts, prisma } = build();
      tts.voices.mockResolvedValue({
        voices: [
          {
            voiceId: 'stock-1',
            name: 'Стоковый',
            previewUrl: null,
            accent: null,
          },
          {
            voiceId: 'cloned-1',
            name: 'Голос Марии',
            previewUrl: null,
            accent: null,
          },
        ],
      });
      prisma.userVoice.findMany.mockResolvedValue([
        { resembleVoiceId: 'cloned-1' },
      ]);
      const r = await ctl.voices();
      expect(r.voices).toEqual([
        {
          voiceId: 'stock-1',
          name: 'Стоковый',
          previewUrl: null,
          accent: null,
        },
      ]);
    });

    it('нет клонов на стенде — каталог не трогается', async () => {
      const { ctl, tts, prisma } = build();
      tts.voices.mockResolvedValue({
        voices: [{ voiceId: 'a', name: 'Аня', previewUrl: null, accent: null }],
      });
      const r = await ctl.voices();
      expect(r.voices).toHaveLength(1);
      expect(prisma.userVoice.findMany).toHaveBeenCalled();
    });
  });

  describe('проба голоса', () => {
    it('успех отдаёт data-URL, а не файл в хранилище', async () => {
      // Проба живёт секунды; класть её в Blob значит заводить мусор,
      // за которым потом придётся ходить подметателю (§22).
      const { ctl } = build();
      const r = await ctl.preview(req, { text: 'Привет' });
      expect(r.ok).toBe(true);
      expect(r.audio).toMatch(/^data:audio\/mpeg;base64,/);
      expect(r.used).toBe(1);
      expect(r.limit).toBe(PREVIEWS_PER_DAY);
    });

    it('ответ уходит только после записи расхода (этап 47, В-2.1)', async () => {
      // Запись была последней строкой перед `return` и шла без await:
      // на Vercel ответ отдан — экземпляр заморожен — INSERT не долетел,
      // и потолок в 30 проб в сутки не срабатывал никогда.
      const { ctl, aiUsage } = build();
      let recorded = false;
      aiUsage.record.mockImplementation(
        () =>
          new Promise<void>((resolve) =>
            setTimeout(() => {
              recorded = true;
              resolve();
            }, 20),
          ),
      );
      await ctl.preview(req, { text: 'Привет' });
      expect(recorded).toBe(true);
    });

    it('расход записывается в символах на пользователя', async () => {
      const { ctl, aiUsage } = build();
      await ctl.preview(req, { text: 'Привет' });
      expect(aiUsage.record).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'voiceover-preview',
          model: 'elevenlabs-tts',
          userId: 'u1',
          characters: 12,
        }),
      );
    });

    it('ключ модели в ai_usage берётся из активного провайдера, не захардкожен', async () => {
      // doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md, находка 6.1: раньше здесь
      // была строка 'elevenlabs-tts' буквально — со вторым провайдером
      // это тихо приписывало бы расход Resemble к ElevenLabs в прайсе.
      const { ctl, tts, aiUsage } = build();
      tts.providerKey = 'resemble';
      await ctl.preview(req, { text: 'Привет' });
      expect(aiUsage.record).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'resemble-tts' }),
      );
    });

    it('блокировка проверяется РАНЬШЕ потолка на пробы', async () => {
      // Заблокированному незачем объяснять, сколько проб у него осталось.
      const { ctl, aiUsage } = build({ blocked: true });
      await expect(ctl.preview(req, { text: 'x' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(aiUsage.countToday).not.toHaveBeenCalled();
    });

    it('исчерпанный потолок отказывает без вызова провайдера', async () => {
      // Ограничение здесь в числе, а не в деньгах: проба стоит копейки,
      // но нажать «Прослушать» двести раз можно за минуту.
      const { ctl, tts } = build({ used: PREVIEWS_PER_DAY });
      const r = await ctl.preview(req, { text: 'x' });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('больше нет');
      expect(tts.synthesize).not.toHaveBeenCalled();
    });

    it('ненастроенный синтез — пропуск, а не сбой, и не тратит пробу', async () => {
      const { ctl, aiUsage } = build();
      const { ctl: c2, tts } = build();
      tts.synthesize.mockResolvedValue({
        ok: false,
        skipped: true,
        reason: 'VOICE_API_KEY не задан',
      });
      expect((await ctl.preview(req, { text: 'x' })).ok).toBe(true);
      const r = await c2.preview(req, { text: 'x' });
      expect(r).toMatchObject({ ok: false, skipped: true });
      expect(aiUsage.record).toHaveBeenCalledTimes(1);
    });

    it('сбой провайдера отличается от пропуска', async () => {
      const { ctl, tts, aiUsage } = build();
      tts.synthesize.mockResolvedValue({
        ok: false,
        skipped: false,
        reason: 'ElevenLabs 401',
      });
      const r = await ctl.preview(req, { text: 'x' });
      expect(r).toMatchObject({ ok: false, skipped: false });
      expect(r.reason).toContain('401');
      // Неудавшаяся проба в счёт не идёт — платить не за что.
      expect(aiUsage.record).not.toHaveBeenCalled();
    });
  });

  // Доп. запрос владельца продукта: явный выбор провайдера ДЛЯ ОДНОЙ
  // СЕССИИ, в обход платформенного дефолта — экран выбора голоса
  // должен уметь показать/прослушать каталог Resemble, даже если на
  // платформе сейчас активен другой провайдер.
  describe('явный выбор провайдера (?provider=/dto.provider)', () => {
    it('voices(provider) зовёт resolveByKey, не resolve — платформенный дефолт не трогаем', async () => {
      const { ctl, ttsResolver } = build();
      await ctl.voices(undefined, 'resemble');
      expect(ttsResolver.resolveByKey).toHaveBeenCalledWith('resemble');
      expect(ttsResolver.resolve).not.toHaveBeenCalled();
    });

    it('voices() без provider — как раньше, resolve() платформенного дефолта', async () => {
      const { ctl, ttsResolver } = build();
      await ctl.voices();
      expect(ttsResolver.resolve).toHaveBeenCalled();
      expect(ttsResolver.resolveByKey).not.toHaveBeenCalled();
    });

    it('voices(provider) с мусорным значением — тихий откат на платформенный дефолт, не 400', async () => {
      const { ctl, ttsResolver } = build();
      await ctl.voices(undefined, 'sora');
      expect(ttsResolver.resolve).toHaveBeenCalled();
      expect(ttsResolver.resolveByKey).not.toHaveBeenCalled();
    });

    it('preview с dto.provider зовёт resolveByKey', async () => {
      const { ctl, ttsResolver } = build();
      await ctl.preview(req, { text: 'x', provider: 'resemble' });
      expect(ttsResolver.resolveByKey).toHaveBeenCalledWith('resemble');
      expect(ttsResolver.resolve).not.toHaveBeenCalled();
    });
  });

  // Доп. запрос владельца продукта: проба репликами ОРИГИНАЛА, не
  // клонирование его диктора — только текст реплик, синтезированный
  // кандидатом на замену голосом.
  describe('проба репликами оригинала (useOriginalDialogue)', () => {
    it('useOriginalDialogue без sessionId — понятный отказ, не падение', async () => {
      const { ctl, analysis } = build();
      const r = await ctl.preview(req, { useOriginalDialogue: true });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('sessionId');
      expect(analysis.extractOriginalDialogueSample).not.toHaveBeenCalled();
    });

    it('useOriginalDialogue + sessionId — берёт текст из AnalysisService, не от клиента', async () => {
      const { ctl, tts, analysis } = build();
      analysis.extractOriginalDialogueSample.mockResolvedValue(
        'Купи уже наконец!',
      );
      await ctl.preview(req, {
        useOriginalDialogue: true,
        sessionId: 's1',
      });
      expect(analysis.extractOriginalDialogueSample).toHaveBeenCalledWith('s1');
      expect(tts.synthesize).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Купи уже наконец!' }),
      );
    });

    it('в оригинале реплик не нашлось (null) — понятная причина, не пустая проба', async () => {
      const { ctl, tts, analysis } = build();
      analysis.extractOriginalDialogueSample.mockResolvedValue(null);
      const r = await ctl.preview(req, {
        useOriginalDialogue: true,
        sessionId: 's1',
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('не нашлось реплик');
      expect(tts.synthesize).not.toHaveBeenCalled();
    });

    it('ни text, ни useOriginalDialogue — понятный отказ', async () => {
      const { ctl, tts } = build();
      const r = await ctl.preview(req, {});
      expect(r.ok).toBe(false);
      expect(tts.synthesize).not.toHaveBeenCalled();
    });
  });
});
