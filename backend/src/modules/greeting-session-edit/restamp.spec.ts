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

function store(initial: any) {
  let row = initial;
  return {
    get row() {
      return row;
    },
    sessions: {
      claimWork: jest.fn().mockResolvedValue(true),
      releaseWork: jest.fn().mockResolvedValue(undefined),
      getSession: jest.fn(async () => row),
      updateSession: jest.fn(async (_id: string, patch: any) => {
        row = { ...row, ...patch };
        return row;
      }),
    },
  };
}

describe('writeWithGreetingRestamp — смена голоса после сценария', () => {
  it('пресет xAI после сценария — сцена перестроена, рендер не видит «устарел»', async () => {
    const st = store(sessionWithScript());
    const before = st.row.generationPrompt;
    await writeWithGreetingRestamp(st.sessions as any, 's1', (fresh) => ({
      greetingBriefSnapshot: {
        ...fresh.greetingBriefSnapshot!,
        presetVoiceId: 'eve',
      },
    }));
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
    await writeWithGreetingRestamp(st.sessions as any, 's1', (fresh) => ({
      greetingBriefSnapshot: {
        ...fresh.greetingBriefSnapshot!,
        senderVoice: { userVoiceId: 'uv', resembleVoiceId: 'rv', label: 'я' },
      },
    }));
    expect(greetingScriptStale(st.row.generationPrompt, st.row)).toBe(false);
  });

  it('фото сменили ДО смены голоса — сценарий не «чинится» молча, рендер попросит собрать заново', async () => {
    const s = sessionWithScript();
    s.greetingReferenceImages = [{ ...PHOTO, id: 'другое', label: 'торт' }];
    const st = store(s);
    const before = st.row.generationPrompt;
    await writeWithGreetingRestamp(st.sessions as any, 's1', (fresh) => ({
      greetingBriefSnapshot: {
        ...fresh.greetingBriefSnapshot!,
        presetVoiceId: 'eve',
      },
    }));
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
});
