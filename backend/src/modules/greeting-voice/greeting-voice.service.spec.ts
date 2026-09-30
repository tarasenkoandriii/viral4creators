/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  GreetingVoiceService,
  PRESET_CACHE_TTL_MS,
  PRESET_EMPTY_TTL_MS,
  PRESET_VOICE_PATH_TIMEOUT_MS,
} from './greeting-voice.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SessionService } from '../../common/session.service';
import type { GrokVideoService } from '../generation/grok-video.service';

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
  };
  const prisma = { userVoice: { findFirst } };
  const listPresetVoices = jest
    .fn()
    .mockResolvedValue([
      { voiceId: 'eve', name: 'Eve', language: 'multilingual' },
    ]);
  const svc = new GreetingVoiceService(
    prisma as unknown as PrismaService,
    sessions as unknown as SessionService,
    { listPresetVoices } as unknown as GrokVideoService,
  );
  return { svc, findFirst, updateSession, sessions, listPresetVoices };
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
    });
    expect(findFirst).not.toHaveBeenCalled();
    expect(updateSession).toHaveBeenCalledWith('s1', {
      greetingBriefSnapshot: { recipientName: 'Аня', senderVoice: null },
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
    expect(view).toEqual({ senderVoice: null, presetVoiceId: 'eve' });
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
    expect(view).toEqual({ senderVoice, presetVoiceId: null });
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
