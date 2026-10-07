/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  GreetingVoiceService,
  PRESET_CACHE_TTL_MS,
  PRESET_EMPTY_TTL_MS,
  PRESET_VOICE_PATH_TIMEOUT_MS,
} from './greeting-voice.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SessionService } from '../../common/session.service';
import type { GrokVideoService } from '../generation/grok-video.service';
import type { TtsProviderResolverService } from '../tts/tts-provider-resolver.service';
import {
  greetingScriptInputs,
  greetingScriptStale,
} from '../greeting-prompt/script-inputs';
import { composeEditedPrompt } from '../greeting-session-edit/greeting-session-edit.service';
import { fakeSnapshotDb } from '../../../test/fake-greeting-snapshot-db';

const READY = {
  id: 'uv1',
  label: 'Мой голос',
  status: 'READY',
  resembleVoiceId: 'clone-42',
};

function build(
  over: {
    session?: Record<string, unknown> | undefined;
    voice?: Record<string, unknown> | null;
    soniox?: {
      configured?: boolean;
      voices?: jest.Mock;
    };
  } = {},
) {
  const findFirst = jest
    .fn()
    .mockResolvedValue(over.voice === undefined ? READY : over.voice);
  const updateSession = jest.fn().mockResolvedValue(undefined);
  const sessions = {
    getSession: jest.fn().mockResolvedValue(
      over.session === undefined
        ? {
            sessionId: 's1',
            userId: 'u1',
            greetingBriefSnapshot: { recipientName: 'Аня', senderVoice: null },
          }
        : over.session,
    ),
    updateSession,
    // CONTRACT6: смена голоса пишется под замком 'prompt' (перештамповка
    // сценария, `writeWithGreetingRestamp`).
    claimWork: jest.fn().mockResolvedValue(true),
    releaseWork: jest.fn().mockResolvedValue(undefined),
  };
  const snapshotDb = fakeSnapshotDb(sessions);
  const prisma = { userVoice: { findFirst }, $queryRaw: snapshotDb.$queryRaw };
  const listPresetVoices = jest
    .fn()
    .mockResolvedValue([
      { voiceId: 'eve', name: 'Eve', language: 'multilingual' },
    ]);
  // Каталог Soniox (S2): по умолчанию ключ есть, в каталоге Maya и Adrian.
  const sonioxVoices =
    over.soniox?.voices ??
    jest.fn().mockResolvedValue({
      voices: [
        {
          voiceId: 'Maya',
          name: 'Maya (female)',
          previewUrl: null,
          accent: null,
        },
        { voiceId: 'Adrian', name: 'Adrian', previewUrl: null, accent: null },
      ],
    });
  const sonioxTts = {
    configured: jest.fn().mockReturnValue(over.soniox?.configured ?? true),
    voices: sonioxVoices,
  };
  const resolveByKey = jest.fn().mockReturnValue(sonioxTts);
  const svc = new GreetingVoiceService(
    prisma as unknown as PrismaService,
    sessions as unknown as SessionService,
    { listPresetVoices } as unknown as GrokVideoService,
    { resolveByKey } as unknown as TtsProviderResolverService,
  );
  return {
    svc,
    findFirst,
    updateSession,
    sessions,
    listPresetVoices,
    sonioxVoices,
    resolveByKey,
  };
}

describe('GreetingVoiceService — голос отправителя (фича №34)', () => {
  it('готовый свой клон записывается в снимок брифа целиком, а не ссылкой', async () => {
    // Копия, а не id: клон можно удалить у себя в кабинете, и ролик,
    // который ссылался бы по id, потерял бы озвучку задним числом.
    const { svc, updateSession } = build();
    const picked = (await svc.select('s1', 'clone-42')).senderVoice;
    expect(picked).toEqual({
      userVoiceId: 'uv1',
      resembleVoiceId: 'clone-42',
      label: 'Мой голос',
    });
    expect(updateSession).toHaveBeenCalledWith('s1', {
      greetingBriefSnapshot: expect.objectContaining({
        recipientName: 'Аня',
        senderVoice: picked,
      }),
    });
  });

  it('чужой голос не выбирается — запрос идёт с userId сессии', async () => {
    // `resembleVoiceId` приходит от клиента, а ключ Resemble у продукта
    // один на всех пользователей: без фильтра по владельцу чужой
    // идентификатор озвучил бы поздравление чужим голосом.
    const { svc, findFirst, updateSession } = build({ voice: null });
    await expect(svc.select('s1', 'clone-чужой')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1', resembleVoiceId: 'clone-чужой' },
      }),
    );
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('голос ещё обучается — отказ сразу, а не молчаливый провал после рендера', async () => {
    // `resembleVoiceId` у TRAINING-записи УЖЕ проставлен: он приходит
    // ответом на запуск обучения, задолго до готовности
    // (`UserVoicesService.confirmClone`). Значит непустой идентификатор
    // «готовностью» не является, и проверять надо именно статус.
    const { svc, updateSession } = build({
      voice: { ...READY, status: 'TRAINING' },
    });
    await expect(svc.select('s1', 'clone-42')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('обучение провалилось — тоже отказ', async () => {
    const { svc } = build({ voice: { ...READY, status: 'FAILED' } });
    await expect(svc.select('s1', 'clone-42')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('анонимная сессия своих клонов не имеет — до базы дело не доходит', async () => {
    const { svc, findFirst } = build({
      session: {
        sessionId: 's1',
        userId: null,
        greetingBriefSnapshot: { recipientName: 'Аня' },
      },
    });
    await expect(svc.select('s1', 'clone-42')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('null снимает выбор, не трогая остальной снимок', async () => {
    const { svc, findFirst, updateSession } = build({
      session: {
        sessionId: 's1',
        userId: 'u1',
        greetingBriefSnapshot: {
          recipientName: 'Аня',
          senderVoice: { userVoiceId: 'uv1', resembleVoiceId: 'c', label: 'L' },
        },
      },
    });
    await expect(svc.select('s1', null)).resolves.toEqual({
      senderVoice: null,
      presetVoiceId: null,
      sonioxVoice: null,
    });
    expect(findFirst).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenCalledWith('s1', {
      // Этап G: признак персоны пересчитывается при каждой смене голоса.
      greetingBriefSnapshot: {
        recipientName: 'Аня',
        senderVoice: null,
        usesPersona: false,
      },
    });
  });

  it('не поздравительная сессия — 404, а не запись senderVoice в товарный снимок', async () => {
    const { svc, updateSession } = build({
      session: { sessionId: 's1', userId: 'u1', productInformation: {} },
    });
    await expect(svc.select('s1', 'clone-42')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('сессии нет вовсе — 404', async () => {
    const { svc } = build({ session: null as never });
    await expect(svc.get('s1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('get отдаёт уже выбранный голос', async () => {
    const senderVoice = {
      userVoiceId: 'uv1',
      resembleVoiceId: 'clone-42',
      label: 'Мой голос',
    };
    const { svc } = build({
      session: {
        sessionId: 's1',
        userId: 'u1',
        greetingBriefSnapshot: { recipientName: 'Аня', senderVoice },
      },
    });
    await expect(svc.get('s1')).resolves.toEqual({
      senderVoice,
      presetVoiceId: null,
      sonioxVoice: null,
    });
  });
});

describe('GreetingVoiceService — пресетный голос xAI', () => {
  it('выбор пресета гасит свой клон — произносить реплику может кто-то один', async () => {
    // Иначе модель произнесёт её в кадре, а наш синтез положит вторую
    // дорожку поверх: ровно то двоение, от которого уходили.
    const { svc, updateSession } = build({
      session: {
        sessionId: 's1',
        userId: 'u1',
        greetingBriefSnapshot: {
          recipientName: 'Аня',
          senderVoice: {
            userVoiceId: 'uv1',
            resembleVoiceId: 'c',
            label: 'L',
          },
        },
      },
    });
    const view = await svc.selectPreset('s1', 'eve');
    expect(view).toEqual({
      senderVoice: null,
      presetVoiceId: 'eve',
      sonioxVoice: null,
    });
    expect(updateSession).toHaveBeenCalledWith('s1', {
      greetingBriefSnapshot: expect.objectContaining({
        recipientName: 'Аня',
        senderVoice: null,
        presetVoiceId: 'eve',
      }),
    });
  });

  it('и наоборот: свой клон гасит пресет', async () => {
    const { svc, updateSession } = build({
      session: {
        sessionId: 's1',
        userId: 'u1',
        greetingBriefSnapshot: { recipientName: 'Аня', presetVoiceId: 'eve' },
      },
    });
    const view = await svc.select('s1', 'clone-42');
    expect(view.presetVoiceId).toBeNull();
    expect(view.senderVoice?.resembleVoiceId).toBe('clone-42');
    expect(updateSession).toHaveBeenCalledWith('s1', {
      greetingBriefSnapshot: expect.objectContaining({ presetVoiceId: null }),
    });
  });

  it('идентификатор приводится к нижнему регистру — роестр xAI регистронезависим', async () => {
    const { svc } = build();
    await expect(svc.selectPreset('s1', '  Eve ')).resolves.toEqual({
      senderVoice: null,
      presetVoiceId: 'eve',
      sonioxVoice: null,
    });
  });

  it('мусор вместо идентификатора отвергается — строка уходит в текст промпта', async () => {
    const { svc, updateSession } = build();
    for (const bad of [
      'a',
      'eve <AUDIO_1>',
      'вова',
      '../../etc',
      'e'.repeat(80),
    ]) {
      await expect(svc.selectPreset('s1', bad)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('null снимает пресет и НЕ трогает свой клон', async () => {
    // Снятие — это снятие, а не «переключись на другое»: гасим только
    // то поле, которое правим.
    const senderVoice = {
      userVoiceId: 'uv1',
      resembleVoiceId: 'c',
      label: 'L',
    };
    const { svc, updateSession } = build({
      session: {
        sessionId: 's1',
        userId: 'u1',
        greetingBriefSnapshot: {
          recipientName: 'Аня',
          presetVoiceId: 'eve',
          senderVoice,
        },
      },
    });
    const view = await svc.selectPreset('s1', null);
    expect(view).toEqual({
      senderVoice,
      presetVoiceId: null,
      sonioxVoice: null,
    });
    expect(updateSession).toHaveBeenCalledWith('s1', {
      greetingBriefSnapshot: expect.objectContaining({ senderVoice }),
    });
  });

  it('роестр берётся у провайдера, своего списка не держим', async () => {
    const { svc, listPresetVoices } = build();
    await expect(svc.listPresetVoices()).resolves.toHaveLength(1);
    expect(listPresetVoices).toHaveBeenCalled();
  });
});

describe('роестр пресетов: кеш и короткий путь голоса (аудит волны K2)', () => {
  const EVE = [{ voiceId: 'eve', name: 'Eve', language: 'multilingual' }];

  it('второй запрос в пределах срока — из кеша', async () => {
    const { svc, listPresetVoices } = build();
    let now = 1_000;
    svc.now = () => now;
    await svc.listPresetVoices();
    now += PRESET_CACHE_TTL_MS - 1;
    await expect(svc.listPresetVoices()).resolves.toEqual(EVE);
    expect(listPresetVoices).toHaveBeenCalledTimes(1);
    now += 2;
    await svc.listPresetVoices();
    expect(listPresetVoices).toHaveBeenCalledTimes(2);
  });

  it('пустой роестр кешируется коротко, исключение — не кешируется', async () => {
    const { svc, listPresetVoices } = build();
    let now = 0;
    svc.now = () => now;
    listPresetVoices.mockResolvedValueOnce([]);
    await expect(svc.listPresetVoices()).resolves.toEqual([]);
    now += PRESET_EMPTY_TTL_MS + 1;
    await expect(svc.listPresetVoices()).resolves.toEqual(EVE);
    expect(listPresetVoices).toHaveBeenCalledTimes(2);

    const b = build();
    b.listPresetVoices.mockRejectedValueOnce(new Error('network'));
    await expect(b.svc.listPresetVoices()).rejects.toThrow('network');
    await expect(b.svc.listPresetVoices()).resolves.toEqual(EVE);
  });

  it('одновременные промахи делят один запрос', async () => {
    const { svc, listPresetVoices } = build();
    await Promise.all([svc.listPresetVoices(), svc.listPresetVoices()]);
    expect(listPresetVoices).toHaveBeenCalledTimes(1);
  });

  it('голосовой путь не ждёт дольше потолка; опоздавший ответ ложится в кеш', async () => {
    const { svc, listPresetVoices } = build();
    let release: (v: unknown) => void = () => undefined;
    listPresetVoices.mockReturnValueOnce(
      new Promise((r) => {
        release = r;
      }),
    );
    await expect(svc.listPresetVoicesQuick(10)).resolves.toEqual([]);
    release(EVE);
    await new Promise((r) => setImmediate(r));
    await expect(svc.listPresetVoicesQuick(10)).resolves.toEqual(EVE);
    expect(listPresetVoices).toHaveBeenCalledTimes(1);
  });

  it('сбой на голосовом пути — пустой список, а не исключение', async () => {
    const { svc, listPresetVoices } = build();
    listPresetVoices.mockRejectedValueOnce(new Error('xai down'));
    await expect(svc.listPresetVoicesQuick()).resolves.toEqual([]);
  });

  it('потолок голосового пути — пара секунд, а не тридцать', () => {
    expect(PRESET_VOICE_PATH_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });
});

describe('GreetingVoiceService — голос персоны делает ролик роликом с персоной (этап G)', () => {
  const OLD_FLAG = process.env.PERSONA_ENABLED;
  beforeEach(() => {
    process.env.PERSONA_ENABLED = 'true';
  });
  afterAll(() => {
    process.env.PERSONA_ENABLED = OLD_FLAG;
  });
  const written = (u: jest.Mock) => u.mock.calls[0][1].greetingBriefSnapshot;

  it('клон персоны: senderVoice помечен, usesPersona = true', async () => {
    const { svc, updateSession } = build({
      voice: { ...READY, personaId: 'p1' },
    });
    await svc.select('s1', 'clone-42');
    expect(written(updateSession).senderVoice.personaVoice).toBe(true);
    expect(written(updateSession).usesPersona).toBe(true);
  });

  it('обычный клон — персоны нет', async () => {
    const { svc, updateSession } = build({
      voice: { ...READY, personaId: null },
    });
    await svc.select('s1', 'clone-42');
    expect(written(updateSession).senderVoice.personaVoice).toBeUndefined();
    expect(written(updateSession).usesPersona).toBe(false);
  });

  it('пресет вместо клона персоны снимает признак, если персоны больше нигде нет', async () => {
    const { svc, updateSession } = build({
      session: {
        sessionId: 's1',
        userId: 'u1',
        greetingBriefSnapshot: {
          senderVoice: {
            userVoiceId: 'uv1',
            resembleVoiceId: 'c',
            label: 'L',
            personaVoice: true,
          },
          usesPersona: true,
        },
      },
    });
    await svc.selectPreset('s1', 'eve');
    expect(written(updateSession).usesPersona).toBe(false);
  });

  it('снятие голоса не снимает признак, если в кадре образ или бренд-бук личный', async () => {
    const { svc, updateSession } = build({
      session: {
        sessionId: 's1',
        userId: 'u1',
        brandManifestSnapshot: { kind: 'PERSONAL' },
        greetingBriefSnapshot: {
          senderVoice: {
            userVoiceId: 'uv1',
            resembleVoiceId: 'c',
            label: 'L',
            personaVoice: true,
          },
          usesPersona: true,
        },
      },
    });
    await svc.select('s1', null);
    expect(written(updateSession).usesPersona).toBe(true);
  });
});

describe('CONTRACT5 — голос персоны отправителем: флаг и монотонность', () => {
  const OLD_FLAG = process.env.PERSONA_ENABLED;
  afterEach(() => {
    process.env.PERSONA_ENABLED = OLD_FLAG;
  });
  it('режим выключен — голос персоны не назначить', async () => {
    process.env.PERSONA_ENABLED = 'false';
    const { svc, updateSession } = build({
      voice: { ...READY, personaId: 'p1' },
    });
    await expect(svc.select('s1', 'clone-42')).rejects.toMatchObject({
      response: { code: 'PERSONA_DISABLED' },
    });
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('после готового ролика снятие голоса персоны признак не снимает (п.5б)', async () => {
    process.env.PERSONA_ENABLED = 'true';
    const { svc, updateSession } = build({
      session: {
        sessionId: 's1',
        userId: 'u1',
        generatedVideo: { status: 'complete' },
        greetingBriefSnapshot: {
          senderVoice: {
            userVoiceId: 'uv1',
            resembleVoiceId: 'c',
            label: 'L',
            personaVoice: true,
          },
          usesPersona: true,
        },
      },
    });
    await svc.selectPreset('s1', 'eve');
    expect(
      updateSession.mock.calls[0][1].greetingBriefSnapshot.usesPersona,
    ).toBe(true);
  });
});

/**
 * CONTRACT6 (регрессия аудита): карточка голоса стоит ПОСЛЕ сценария —
 * выбор голоса перештамповывает сценарий, и рендер не отказывает
 * «сценарий устарел».
 */
describe('GreetingVoiceService — перештамповка сценария (CONTRACT6)', () => {
  it('пресет после сценария — в той же записи сценарий под новый голос', async () => {
    const brief = {
      occasion: 'BIRTHDAY',
      customOccasionText: null,
      recipientName: 'Аня',
      tone: 'WARM',
      presetVoiceId: null,
      senderVoice: null,
    };
    const session: any = {
      sessionId: 's1',
      userId: 'u1',
      greetingBriefSnapshot: brief,
      greetingReferenceImages: [],
    };
    session.generationPrompt = {
      ...composeEditedPrompt(
        null,
        brief as never,
        'Аня, с днём рождения!',
        [],
        'voiceover',
        () => ({ status: 'approved' as never, flags: [] }),
        null,
      ),
      greetingScriptInputs: greetingScriptInputs(session),
    };
    const { svc, updateSession } = build({ session });

    await svc.selectPreset('s1', 'eve');

    const patch = updateSession.mock.calls[0][1];
    expect(patch.generationPrompt.finalText).toContain('<AUDIO_0>');
    expect(
      greetingScriptStale(patch.generationPrompt, { ...session, ...patch }),
    ).toBe(false);
  });
});

/** Тело исключения Nest — `{ code, message }` из `greetingError`. */
async function codeOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e: any) {
    return { status: e.getStatus?.(), code: e.getResponse?.()?.code };
  }
  return 'не бросил';
}

describe('GreetingVoiceService — голос Soniox (S2)', () => {
  const CLONE = { userVoiceId: 'uv1', resembleVoiceId: 'c', label: 'L' };
  const withVoices = (brief: Record<string, unknown>) =>
    build({
      session: {
        sessionId: 's1',
        userId: 'u1',
        greetingBriefSnapshot: { recipientName: 'Аня', ...brief },
      },
    });

  it('голос каталога пишется копией с именем из каталога и гасит клон и пресет', async () => {
    const { svc, updateSession, resolveByKey } = withVoices({
      senderVoice: CLONE,
      presetVoiceId: 'eve',
    });
    const view = await svc.selectSoniox('s1', { voiceId: ' Maya ' });
    expect(view).toEqual({
      senderVoice: null,
      presetVoiceId: null,
      sonioxVoice: { voiceId: 'Maya', label: 'Maya (female)' },
    });
    expect(resolveByKey).toHaveBeenCalledWith('soniox');
    expect(updateSession).toHaveBeenCalledWith('s1', {
      greetingBriefSnapshot: expect.objectContaining({
        senderVoice: null,
        presetVoiceId: null,
        sonioxVoice: { voiceId: 'Maya', label: 'Maya (female)' },
      }),
    });
  });

  it('voiceId null или пусто — голос Soniox по умолчанию, каталог не нужен', async () => {
    for (const voiceId of [null, '', '   ', undefined]) {
      const { svc, sonioxVoices } = withVoices({});
      const view = await svc.selectSoniox('s1', { voiceId });
      expect(view.sonioxVoice).toEqual({ voiceId: null, label: null });
      expect(sonioxVoices).not.toHaveBeenCalled();
    }
  });

  it('null снимает только Soniox — клон и пресет не трогает', async () => {
    const soniox = { voiceId: 'Maya', label: 'Maya' };
    const { svc, updateSession } = withVoices({ sonioxVoice: soniox });
    const view = await svc.selectSoniox('s1', null);
    expect(view.sonioxVoice).toBeNull();
    const written = updateSession.mock.calls[0][1].greetingBriefSnapshot;
    expect(written.sonioxVoice).toBeNull();
    expect('senderVoice' in written).toBe(false);
    expect('presetVoiceId' in written).toBe(false);
  });

  it('выбор клона и пресета гасит Soniox', async () => {
    const soniox = { voiceId: 'Maya', label: 'Maya' };
    const a = withVoices({ sonioxVoice: soniox });
    expect((await a.svc.select('s1', 'clone-42')).sonioxVoice).toBeNull();
    const b = withVoices({ sonioxVoice: soniox });
    expect((await b.svc.selectPreset('s1', 'eve')).sonioxVoice).toBeNull();
    // Снятие клона/пресета Soniox не трогает — гасится только своё поле.
    const c = withVoices({ sonioxVoice: soniox });
    expect((await c.svc.select('s1', null)).sonioxVoice).toEqual(soniox);
    const d = withVoices({ sonioxVoice: soniox });
    expect((await d.svc.selectPreset('s1', null)).sonioxVoice).toEqual(soniox);
  });

  it('голоса нет в каталоге — 400 с кодом, ничего не пишется', async () => {
    const { svc, updateSession } = withVoices({});
    await expect(
      codeOf(svc.selectSoniox('s1', { voiceId: 'Zed' })),
    ).resolves.toEqual({ status: 400, code: 'GREETING_SONIOX_VOICE_UNKNOWN' });
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('строка не похожа на id — 400 до похода в каталог', async () => {
    const { svc, sonioxVoices, updateSession } = withVoices({});
    for (const bad of ['<AUDIO_0>', '../x', 'й', 'a'.repeat(80)]) {
      await expect(
        codeOf(svc.selectSoniox('s1', { voiceId: bad })),
      ).resolves.toEqual({
        status: 400,
        code: 'GREETING_SONIOX_VOICE_UNKNOWN',
      });
    }
    expect(sonioxVoices).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('каталог не прочитан — мягко: голос принимается по форме id', async () => {
    const voices = jest
      .fn()
      .mockResolvedValue({ voices: [], error: 'Soniox ответил 503' });
    const { svc } = build({ soniox: { voices } });
    const view = await svc.selectSoniox('s1', { voiceId: 'Zed' });
    expect(view.sonioxVoice).toEqual({ voiceId: 'Zed', label: 'Zed' });
  });

  it('нет ключа Soniox — 400 GREETING_SONIOX_UNAVAILABLE, даже для голоса по умолчанию', async () => {
    const { svc, updateSession } = build({ soniox: { configured: false } });
    for (const choice of [{ voiceId: null }, { voiceId: 'Maya' }]) {
      await expect(codeOf(svc.selectSoniox('s1', choice))).resolves.toEqual({
        status: 400,
        code: 'GREETING_SONIOX_UNAVAILABLE',
      });
    }
    expect(updateSession).not.toHaveBeenCalled();
    // Снять можно и без ключа — это не синтез.
    await expect(svc.selectSoniox('s1', null)).resolves.toMatchObject({
      sonioxVoice: null,
    });
  });

  it('во время рендера — 409 GREETING_CHANGE_DURING_RENDER', async () => {
    const { svc, updateSession, sessions } = withVoices({});
    sessions.getSession.mockResolvedValue({
      sessionId: 's1',
      userId: 'u1',
      greetingBriefSnapshot: { recipientName: 'Аня' },
      generatedVideo: { status: 'processing' },
    });
    const p = svc.selectSoniox('s1', { voiceId: 'Maya' });
    await expect(p).rejects.toBeInstanceOf(ConflictException);
    await expect(codeOf(svc.selectSoniox('s1', null))).resolves.toEqual({
      status: 409,
      code: 'GREETING_CHANGE_DURING_RENDER',
    });
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('клоновые ограничения не применяются: владельца в базе не ищем, персоны нет', async () => {
    const { svc, findFirst, updateSession } = withVoices({
      senderVoice: { ...CLONE, personaVoice: true },
      usesPersona: true,
    });
    await svc.selectSoniox('s1', { voiceId: 'Adrian' });
    expect(findFirst).not.toHaveBeenCalled();
    expect(
      updateSession.mock.calls[0][1].greetingBriefSnapshot.usesPersona,
    ).toBe(false);
  });

  it('каталог кешируется по языку; сбой — коротко', async () => {
    const { svc, sonioxVoices } = withVoices({});
    let t = 0;
    svc.now = () => t;
    await svc.listSonioxVoices('ru');
    await svc.listSonioxVoices('RU');
    expect(sonioxVoices).toHaveBeenCalledTimes(1);
    expect(sonioxVoices).toHaveBeenLastCalledWith('ru');
    await svc.listSonioxVoices();
    expect(sonioxVoices).toHaveBeenCalledTimes(2);
    expect(sonioxVoices).toHaveBeenLastCalledWith(undefined);
    t = PRESET_CACHE_TTL_MS - 1;
    await svc.listSonioxVoices('ru');
    expect(sonioxVoices).toHaveBeenCalledTimes(2);
    t = PRESET_CACHE_TTL_MS + 1;
    await svc.listSonioxVoices('ru');
    expect(sonioxVoices).toHaveBeenCalledTimes(3);

    sonioxVoices.mockResolvedValue({ voices: [], error: 'сбой' });
    t = 10 * PRESET_CACHE_TTL_MS;
    await expect(svc.listSonioxVoices('de')).resolves.toBeNull();
    t += PRESET_EMPTY_TTL_MS - 1;
    await svc.listSonioxVoices('de');
    expect(sonioxVoices).toHaveBeenCalledTimes(4);
    t += 2;
    await svc.listSonioxVoices('de');
    expect(sonioxVoices).toHaveBeenCalledTimes(5);
  });

  it('голосовой путь: сбой и таймаут — пустой список', async () => {
    const voices = jest.fn().mockRejectedValue(new Error('сеть'));
    const a = build({ soniox: { voices } });
    await expect(a.svc.listSonioxVoicesQuick('ru')).resolves.toEqual([]);
    const slow = jest.fn().mockReturnValue(new Promise(() => undefined));
    const b = build({ soniox: { voices: slow } });
    await expect(b.svc.listSonioxVoicesQuick('ru', 5)).resolves.toEqual([]);
    const c = withVoices({});
    await expect(c.svc.listSonioxVoicesQuick('ru')).resolves.toHaveLength(2);
  });

  it('смена голоса на Soniox после сценария — сценарий перештампован, ведущий молчит', async () => {
    const brief = {
      occasion: 'BIRTHDAY',
      customOccasionText: null,
      recipientName: 'Аня',
      tone: 'WARM',
      presetVoiceId: 'eve',
      senderVoice: null,
    };
    const session: any = {
      sessionId: 's1',
      userId: 'u1',
      greetingBriefSnapshot: brief,
      greetingReferenceImages: [],
      // Бренд в режиме 'veo': без Soniox сцена просила бы речь в кадре.
      brandManifestSnapshot: { voiceMode: 'veo' },
    };
    session.generationPrompt = {
      ...composeEditedPrompt(
        null,
        brief as never,
        'Аня, с днём рождения!',
        [],
        'veo',
        () => ({ status: 'approved' as never, flags: [] }),
        null,
      ),
      greetingScriptInputs: greetingScriptInputs(session),
    };
    expect(session.generationPrompt.finalText).toContain('<AUDIO_0>');
    const { svc, updateSession } = build({ session });

    await svc.selectSoniox('s1', { voiceId: null });

    const patch = updateSession.mock.calls[0][1];
    expect(patch.generationPrompt.finalText).not.toContain('<AUDIO_0>');
    expect(patch.generationPrompt.finalText).toContain(
      'does NOT say the line out loud',
    );
    expect(
      greetingScriptStale(patch.generationPrompt, { ...session, ...patch }),
    ).toBe(false);
  });
});
