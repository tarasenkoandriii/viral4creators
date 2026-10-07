/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые двойники */
/**
 * CONTRACT6, регрессия проверочного аудита: смена голоса после сценария
 * не должна делать рендер невозможным — сценарий перештамповывается.
 */
jest.mock('../../common/session.service', () => ({ SessionService: class {} }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ConflictException } from '@nestjs/common';
import { restampedGreetingPrompt, writeWithGreetingRestamp } from './restamp';
import { composeEditedPrompt } from './greeting-session-edit.service';
import {
  greetingScriptInputs,
  greetingScriptStale,
} from '../greeting-prompt/script-inputs';
import { ModerationStatus } from '../../common/types/prompt.types';
import { fakeSnapshotDb } from '../../../test/fake-greeting-snapshot-db';

const BRIEF = {
  sourceGreetingBriefId: 'gb1',
  occasion: 'BIRTHDAY',
  customOccasionText: null,
  recipientName: 'Марина',
  senderName: 'Андрей',
  tone: 'WARM',
  personalMessage: null,
  requestedPresenterProvider: 'grok',
  resolvedPresenterProvider: 'grok',
  requestedResolution: '720p',
  resolvedResolution: '720p',
  brandManifestId: null,
  occasionDate: null,
  addedAt: '2026-09-30T00:00:00.000Z',
  presetVoiceId: null,
  senderVoice: null,
} as any;

const PHOTO = {
  id: 'img1',
  label: 'дача',
  description: null,
  photoUrl: 'https://blob/sessions/s1/img1.jpg',
  photoPathname: 'sessions/s1/img1.jpg',
  hasFace: false,
};

/** Сессия со сценарием, собранным под текущие входы — как после сборки. */
function sessionWithScript(over: Record<string, unknown> = {}): any {
  const base: any = {
    sessionId: 's1',
    greetingBriefSnapshot: BRIEF,
    greetingReferenceImages: [PHOTO],
    brandManifestSnapshot: null,
    ...over,
  };
  const prompt = composeEditedPrompt(
    null,
    base.greetingBriefSnapshot,
    'Марина, с днём рождения!',
    base.greetingReferenceImages,
    'voiceover',
    () => ({ status: ModerationStatus.APPROVED, flags: [] }),
    null,
  );
  base.generationPrompt = {
    ...prompt,
    userEditedText: undefined,
    voiceoverScriptEdited: undefined,
    greetingScriptInputs: greetingScriptInputs(base),
  };
  return base;
}

function store(
  initial: any,
  beforeWrite?: (attempt: number, set: (brief: any) => void) => void,
) {
  let row = initial;
  const sessions = {
    claimWork: jest.fn().mockResolvedValue(true),
    releaseWork: jest.fn().mockResolvedValue(undefined),
    getSession: jest.fn(async () => row),
    updateSession: jest.fn(async (_id: string, patch: any) => {
      row = { ...row, ...patch };
      return row;
    }),
  };
  // «Параллельная» правка снимка мимо замка (наклейка, музыка, сцены).
  const set = (brief: any) => {
    row = {
      ...row,
      greetingBriefSnapshot: { ...row.greetingBriefSnapshot, ...brief },
    };
  };
  return {
    get row() {
      return row;
    },
    sessions,
    db: fakeSnapshotDb(sessions, {
      beforeWrite: (n) => beforeWrite?.(n, set),
    }),
  };
}

describe('writeWithGreetingRestamp — смена голоса после сценария', () => {
  it('пресет xAI после сценария — сцена перестроена, рендер не видит «устарел»', async () => {
    const st = store(sessionWithScript());
    const before = st.row.generationPrompt;
    await writeWithGreetingRestamp(
      st.sessions as any,
      's1',
      (fresh) => ({
        greetingBriefSnapshot: {
          ...fresh.greetingBriefSnapshot!,
          presetVoiceId: 'eve',
        },
      }),
      st.db,
    );
    const after = st.row.generationPrompt;
    expect(greetingScriptStale(after, st.row)).toBe(false);
    expect(after.finalText).toContain('<AUDIO_0>');
    expect(before.finalText).not.toContain('<AUDIO_0>');
    // Реплика и история сценария — те же, модель не звали.
    expect(after.promptId).toBe(before.promptId);
    expect(after.finalVoiceoverScript).toBe('Марина, с днём рождения!');
    expect(after.generatedText).toBe(before.generatedText);
    expect(after.userEditedText).toBeUndefined();
    expect(after.moderationStatus).toBe(ModerationStatus.APPROVED);
    expect(st.sessions.claimWork).toHaveBeenCalledWith(
      's1',
      'prompt',
      expect.any(Number),
    );
    expect(st.sessions.releaseWork).toHaveBeenCalledWith('s1', 'prompt');
  });

  it('режим озвучки бренда (veo) — ведущий больше не «молчит», сценарий свежий', async () => {
    const st = store(sessionWithScript());
    await writeWithGreetingRestamp(st.sessions as any, 's1', () => ({
      brandManifestSnapshot: { voiceMode: 'veo', scenes: [] } as any,
    }));
    expect(greetingScriptStale(st.row.generationPrompt, st.row)).toBe(false);
    expect(st.row.generationPrompt.finalText).not.toContain(
      'does NOT say the line out loud',
    );
  });

  it('клон отправителя — отпечаток обновлён', async () => {
    const st = store(sessionWithScript());
    await writeWithGreetingRestamp(
      st.sessions as any,
      's1',
      (fresh) => ({
        greetingBriefSnapshot: {
          ...fresh.greetingBriefSnapshot!,
          senderVoice: { userVoiceId: 'uv', resembleVoiceId: 'rv', label: 'я' },
        },
      }),
      st.db,
    );
    expect(greetingScriptStale(st.row.generationPrompt, st.row)).toBe(false);
  });

  it('фото сменили ДО смены голоса — сценарий не «чинится» молча, рендер попросит собрать заново', async () => {
    const s = sessionWithScript();
    s.greetingReferenceImages = [{ ...PHOTO, id: 'другое', label: 'торт' }];
    const st = store(s);
    const before = st.row.generationPrompt;
    await writeWithGreetingRestamp(
      st.sessions as any,
      's1',
      (fresh) => ({
        greetingBriefSnapshot: {
          ...fresh.greetingBriefSnapshot!,
          presetVoiceId: 'eve',
        },
      }),
      st.db,
    );
    expect(st.row.generationPrompt).toBe(before);
    expect(greetingScriptStale(st.row.generationPrompt, st.row)).toBe(true);
  });

  it('ролик готов — сценарий готового ролика не трогается', () => {
    const s = sessionWithScript({ generatedVideo: { status: 'complete' } });
    const after = {
      ...s,
      greetingBriefSnapshot: {
        ...s.greetingBriefSnapshot,
        presetVoiceId: 'eve',
      },
    };
    expect(restampedGreetingPrompt(s, after)).toBeNull();
  });

  it('упавший ролик — перештамповка идёт (повтор рендера возможен)', () => {
    const s = sessionWithScript({ generatedVideo: { status: 'failed' } });
    const after = {
      ...s,
      greetingBriefSnapshot: {
        ...s.greetingBriefSnapshot,
        presetVoiceId: 'eve',
      },
    };
    expect(restampedGreetingPrompt(s, after)).not.toBeNull();
  });

  it('сценарий без отпечатка (до волны) — не трогается', () => {
    const s = sessionWithScript();
    delete s.generationPrompt.greetingScriptInputs;
    const after = {
      ...s,
      greetingBriefSnapshot: {
        ...s.greetingBriefSnapshot,
        presetVoiceId: 'eve',
      },
    };
    expect(restampedGreetingPrompt(s, after)).toBeNull();
  });

  it('замок правки занят — 409 с кодом, записи нет', async () => {
    const st = store(sessionWithScript());
    st.sessions.claimWork.mockResolvedValue(false);
    const err = await writeWithGreetingRestamp(
      st.sessions as any,
      's1',
      () => ({}),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().code).toBe('GREETING_EDIT_IN_PROGRESS');
    expect(st.sessions.updateSession).not.toHaveBeenCalled();
  });

  it('под замком ролик уже считается — 409 с кодом, запись не идёт, замок снят', async () => {
    const st = store(
      sessionWithScript({ generatedVideo: { status: 'processing' } }),
    );
    const err = await writeWithGreetingRestamp(
      st.sessions as any,
      's1',
      () => ({}),
    ).catch((e) => e);
    expect(err.getResponse().code).toBe('GREETING_CHANGE_DURING_RENDER');
    expect(st.sessions.updateSession).not.toHaveBeenCalled();
    expect(st.sessions.releaseWork).toHaveBeenCalledWith('s1', 'prompt');
  });

  describe('C2: снимок пишется точечно и не затирает правки мимо замка', () => {
    const preset = (fresh: any) => ({
      greetingBriefSnapshot: {
        ...fresh.greetingBriefSnapshot!,
        presetVoiceId: 'eve',
      },
    });

    it('пишутся только изменённые ключи снимка, сценарий — той же записью', async () => {
      const st = store(sessionWithScript());
      await writeWithGreetingRestamp(st.sessions as any, 's1', preset, st.db);
      expect(st.db.applied).toHaveLength(1);
      expect(st.db.applied[0].set).toEqual({ presetVoiceId: 'eve' });
      expect(st.db.applied[0].remove).toEqual([]);
      expect(Object.keys(st.db.applied[0].data)).toEqual(['generationPrompt']);
    });

    it('наклейку выбрали между чтением и записью — она остаётся, голос и перештамповка ложатся поверх', async () => {
      const sticker = { id: 'st_1', url: 'u', pathname: 'p' };
      const st = store(sessionWithScript(), (n, set) => {
        if (n === 1) set({ sticker });
      });
      await writeWithGreetingRestamp(st.sessions as any, 's1', preset, st.db);
      expect(st.db.writes).toHaveLength(2);
      expect(st.row.greetingBriefSnapshot).toEqual(
        expect.objectContaining({ sticker, presetVoiceId: 'eve' }),
      );
      expect(greetingScriptStale(st.row.generationPrompt, st.row)).toBe(false);
      expect(st.sessions.releaseWork).toHaveBeenCalledWith('s1', 'prompt');
    });

    it('снимок меняют под руками три раза подряд — 409 GREETING_EDIT_IN_PROGRESS, замок снят', async () => {
      let i = 0;
      const st = store(sessionWithScript(), (_n, set) => {
        set({ sceneCount: ++i });
      });
      const err = await writeWithGreetingRestamp(
        st.sessions as any,
        's1',
        preset,
        st.db,
      ).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().code).toBe('GREETING_EDIT_IN_PROGRESS');
      expect(st.db.writes).toHaveLength(3);
      expect(st.db.applied).toHaveLength(0);
      expect(st.row.greetingBriefSnapshot.presetVoiceId).toBeNull();
      expect(st.sessions.releaseWork).toHaveBeenCalledWith('s1', 'prompt');
    });

    it('правка снимка без db — ошибка программиста, а не тихая запись целиком', async () => {
      const st = store(sessionWithScript());
      await expect(
        writeWithGreetingRestamp(st.sessions as any, 's1', preset),
      ).rejects.toThrow('требует db');
      expect(st.sessions.updateSession).not.toHaveBeenCalled();
    });
  });
});
