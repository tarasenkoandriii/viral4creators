/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые двойники */
/**
 * CONTRACT6 п.3/п.4 (G-B1): отпечаток входов сценария и страховка правки
 * после записи.
 */
import { ConflictException } from '@nestjs/common';
import {
  assertNoRenderAfterWrite,
  greetingScriptInputs,
  greetingScriptStale,
} from './script-inputs';

const img = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  label: `фото ${id}`,
  description: null,
  photoUrl: `https://blob/sessions/s1/${id}.jpg`,
  photoPathname: `sessions/s1/${id}.jpg`,
  hasFace: false,
  ...over,
});

const base = () => ({
  greetingBriefSnapshot: {
    presenter: null,
    presetVoiceId: null,
    senderVoice: null,
  },
  greetingReferenceImages: [img('a'), img('b')],
  brandManifestSnapshot: null,
});

describe('greetingScriptInputs / greetingScriptStale', () => {
  const stamped = () => ({
    greetingScriptInputs: greetingScriptInputs(base() as never),
  });

  it('те же входы — не устарел', () => {
    expect(greetingScriptStale(stamped(), base() as never)).toBe(false);
  });

  it('сценарий без отпечатка (до правки) — не устарел', () => {
    expect(greetingScriptStale({}, base() as never)).toBe(false);
    expect(greetingScriptStale(null, base() as never)).toBe(false);
  });

  const changes: Array<[string, (s: any) => void]> = [
    ['порядок фото', (s) => s.greetingReferenceImages.reverse()],
    ['фото удалено', (s) => s.greetingReferenceImages.pop()],
    ['фото добавлено', (s) => s.greetingReferenceImages.push(img('c'))],
    ['подпись фото', (s) => (s.greetingReferenceImages[0].label = 'торт')],
    ['пресетный голос', (s) => (s.greetingBriefSnapshot.presetVoiceId = 'eve')],
    [
      'клон отправителя',
      (s) =>
        (s.greetingBriefSnapshot.senderVoice = {
          userVoiceId: 'uv',
          resembleVoiceId: 'rv',
          label: 'мой',
        }),
    ],
    [
      'режим озвучки бренда',
      (s) => (s.brandManifestSnapshot = { voiceMode: 'veo', scenes: [] }),
    ],
    [
      'образ ведущего',
      (s) =>
        (s.greetingBriefSnapshot.presenter = {
          lookId: 'l1',
          variant: 'photo',
          url: 'u',
        }),
    ],
    [
      'сцена бренд-бука',
      (s) =>
        (s.brandManifestSnapshot = {
          voiceMode: null,
          scenes: [
            {
              sourceSceneId: 'b1',
              label: 'Офис',
              photoUrl: null,
              description: null,
            },
          ],
        }),
    ],
  ];
  it.each(changes)('сменилось: %s — устарел', (_name, mutate) => {
    const cur = base();
    mutate(cur);
    expect(greetingScriptStale(stamped(), cur as never)).toBe(true);
  });

  it('адрес фото сменился (копия в новую версию) — не устарел', () => {
    const cur = base();
    cur.greetingReferenceImages = cur.greetingReferenceImages.map((i) => ({
      ...i,
      photoUrl: i.photoUrl.replace('s1', 's2'),
      photoPathname: i.photoPathname.replace('s1', 's2'),
    }));
    expect(greetingScriptStale(stamped(), cur as never)).toBe(false);
  });
});

describe('greetingScriptInputs — голос Soniox (S2)', () => {
  const stamp = (brief: Record<string, unknown>) =>
    greetingScriptInputs({
      ...base(),
      greetingBriefSnapshot: { ...base().greetingBriefSnapshot, ...brief },
    } as never);

  it('без Soniox отпечаток прежний — уже собранные сессии не устаревают', () => {
    // Ключ `soniox` в отпечатке без выбора сменил бы его у ВСЕХ сессий.
    const plain = stamp({});
    expect(plain).not.toContain('soniox');
    expect(stamp({ sonioxVoice: null })).toBe(plain);
  });

  it('Soniox по умолчанию, голос каталога и другой голос — три разных отпечатка', () => {
    const none = stamp({});
    const def = stamp({ sonioxVoice: { voiceId: null, label: null } });
    const maya = stamp({ sonioxVoice: { voiceId: 'Maya', label: 'Maya' } });
    const adrian = stamp({ sonioxVoice: { voiceId: 'Adrian', label: 'A' } });
    expect(new Set([none, def, maya, adrian]).size).toBe(4);
    // Имя из каталога — не вход сценария: сцена от него не меняется.
    expect(stamp({ sonioxVoice: { voiceId: 'Maya', label: 'другое' } })).toBe(
      maya,
    );
  });
});

describe('assertNoRenderAfterWrite', () => {
  it('ролик не появился — ничего не делает', async () => {
    const sessions = {
      getSession: jest.fn().mockResolvedValue({ generatedVideo: undefined }),
      updateSession: jest.fn(),
    };
    await assertNoRenderAfterWrite(sessions as never, 's1', {
      generationPrompt: undefined,
    });
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('ролик запустился — прежнее возвращается, 409 с кодом', async () => {
    const sessions = {
      getSession: jest
        .fn()
        .mockResolvedValue({ generatedVideo: { status: 'processing' } }),
      updateSession: jest.fn(),
    };
    const restore = { generationPrompt: { promptId: 'old' } as never };
    const err = await assertNoRenderAfterWrite(
      sessions as never,
      's1',
      restore,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().code).toBe('GREETING_EDIT_AFTER_RENDER_STARTED');
    expect(sessions.updateSession).toHaveBeenCalledWith('s1', restore);
  });
});
