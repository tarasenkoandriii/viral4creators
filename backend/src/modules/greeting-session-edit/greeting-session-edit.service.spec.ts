/**
 * Правка брифа и сценария после старта — этап C ТЗ
 * docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §3.6 (Г-3, Г-4).
 *
 * Главное, что здесь закреплено:
 * - правка доходит до СЕССИИ, а не только до брифа проекта (Г-3);
 * - сцена и озвучка меняются только вместе (Г-4);
 * - шутливое соболезнование не проходит и этим путём;
 * - во время рендера — 409, после готового ролика — новая версия.
 */
jest.mock('../../common/session.service', () => ({ SessionService: class {} }));
jest.mock('../plan/plan.service', () => ({ PlanService: class {} }));
jest.mock('../ai-usage/ai-usage.service', () => ({ AiUsageService: class {} }));
jest.mock('../prompt/prompt.service', () => ({ PromptService: class {} }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../storage/blob.service', () => ({ BlobService: class {} }));

import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  GreetingSessionEditService,
  composeEditedPrompt,
  registerWarningFor,
} from './greeting-session-edit.service';
import { GreetingBriefService } from '../greeting-brief/greeting-brief.service';
import {
  contentTypeOf,
  editModeOf,
  rebaseSessionPath,
  reconcileSelections,
  scriptInputsChanged,
} from '../../common/greeting-session-edit';
import { GenerationStatus } from '../../common/types/generation.types';
import { ModerationStatus } from '../../common/types/prompt.types';
import type { GreetingBriefSnapshot } from '../../common/types/greeting.types';

const snap = (over: Partial<GreetingBriefSnapshot> = {}) =>
  ({
    sourceGreetingBriefId: 'gb1',
    occasion: 'BIRTHDAY',
    customOccasionText: null,
    recipientName: 'Марина',
    senderName: 'Андрей',
    tone: 'FUNNY',
    personalMessage: null,
    requestedPresenterProvider: 'grok',
    resolvedPresenterProvider: 'grok',
    requestedResolution: '720p',
    resolvedResolution: '720p',
    brandManifestId: null,
    occasionDate: null,
    addedAt: '2026-09-22T10:00:00.000Z',
    ...over,
  }) as GreetingBriefSnapshot;

const sticker = (sessionId = 's1') => ({
  id: 'st1',
  url: `https://blob/sessions/${sessionId}/stickers/st1.png`,
  pathname: `sessions/${sessionId}/stickers/st1.png`,
  sourceUrl: 'https://pixabay.com/x',
  source: 'pixabay' as const,
  placement: 'top-right',
});

const prompt = () => ({
  promptId: 'p-old',
  generatedText: 'old scene',
  finalText: 'old scene',
  characterCount: 9,
  generatedAt: new Date('2026-09-22T10:00:00Z'),
  moderationStatus: ModerationStatus.APPROVED,
  voiceoverScript: 'старый текст',
  finalVoiceoverScript: 'старый текст',
});

// ── чистые решения ────────────────────────────────────────────────────

describe('scriptInputsChanged', () => {
  it('смена тона, повода, получателя или языка устаревает сценарий', () => {
    const a = snap();
    expect(scriptInputsChanged(a, snap({ tone: 'WARM' }))).toBe(true);
    expect(scriptInputsChanged(a, snap({ occasion: 'ANNIVERSARY' }))).toBe(
      true,
    );
    expect(scriptInputsChanged(a, snap({ recipientName: 'Аня' }))).toBe(true);
    expect(scriptInputsChanged(a, snap({ scriptLanguage: 'de' }), 'ru')).toBe(
      true,
    );
  });
  it('выбор того же языка, что был по умолчанию, — не смена', () => {
    expect(
      scriptInputsChanged(snap(), snap({ scriptLanguage: 'ru' }), 'ru'),
    ).toBe(false);
  });
  it('провайдер и качество видео на текст не влияют', () => {
    expect(
      scriptInputsChanged(
        snap(),
        snap({ requestedResolution: '1080p', resolvedResolution: '1080p' }),
      ),
    ).toBe(false);
  });
  it('смена регистра «Особого повода» — тоже смена смысла', () => {
    const a = snap({
      occasion: 'OTHER',
      customOccasionText: 'x',
      tone: 'WARM',
    });
    expect(scriptInputsChanged(a, { ...a, occasionRegister: 'MOURNING' })).toBe(
      true,
    );
  });
});

describe('reconcileSelections', () => {
  it('наклейка сбрасывается при переходе к соболезнованию, и это видно', () => {
    const r = reconcileSelections(
      snap({ occasion: 'CONDOLENCE', tone: 'RESPECTFUL', sticker: sticker() }),
    );
    expect(r.snapshot.sticker).toBeNull();
    expect(r.resetFields).toContain('sticker');
  });
  it('каталожная праздничная музыка сбрасывается, своя — нет', () => {
    const festive = reconcileSelections(
      snap({
        occasion: 'CONDOLENCE',
        tone: 'RESPECTFUL',
        musicTheme: {
          id: 't1',
          title: 'Party',
          url: 'u',
          source: 'catalog',
          occasions: ['BIRTHDAY'],
        } as never,
      }),
    );
    expect(festive.resetFields).toContain('musicTheme');
    const own = reconcileSelections(
      snap({
        occasion: 'CONDOLENCE',
        tone: 'RESPECTFUL',
        musicTheme: {
          id: 't2',
          title: 'Mine',
          url: 'u',
          source: 'upload',
        } as never,
      }),
    );
    expect(own.resetFields).not.toContain('musicTheme');
    expect(own.snapshot.musicTheme).not.toBeNull();
  });
  it('лишние сцены урезаются до потолка регистра', () => {
    const r = reconcileSelections(
      snap({ occasion: 'CONDOLENCE', tone: 'RESPECTFUL', sceneCount: 4 }),
    );
    expect(r.snapshot.sceneCount).toBe(2);
    expect(r.resetFields).toContain('sceneCount');
  });
  it('совместимое остаётся как было', () => {
    const r = reconcileSelections(snap({ sticker: sticker(), sceneCount: 3 }));
    expect(r.resetFields).toEqual([]);
    expect(r.snapshot.sticker).not.toBeNull();
  });
});

describe('editModeOf', () => {
  it.each([
    [undefined, 'in-place'],
    [GenerationStatus.PENDING, 'busy'],
    [GenerationStatus.PROCESSING, 'busy'],
    [GenerationStatus.COMPLETE, 'new-version'],
    [GenerationStatus.FAILED, 'in-place'],
  ])('%s → %s', (status, mode) => {
    expect(editModeOf(status ? { status } : null)).toBe(mode);
  });
});

describe('rebaseSessionPath / contentTypeOf', () => {
  it('переносит только файлы из папки сессии-источника', () => {
    expect(rebaseSessionPath('sessions/a/stickers/x.png', 'a', 'b')).toBe(
      'sessions/b/stickers/x.png',
    );
    expect(rebaseSessionPath('music/catalog/x.mp3', 'a', 'b')).toBeNull();
    expect(rebaseSessionPath('sessions/ab/x.png', 'a', 'b')).toBeNull();
  });
  it('тип содержимого по расширению', () => {
    expect(contentTypeOf('a/b.png')).toBe('image/png');
    expect(contentTypeOf('a/b.mp3')).toBe('audio/mpeg');
    expect(contentTypeOf('a/b')).toBe('application/octet-stream');
  });
});

describe('composeEditedPrompt — сцена и озвучка из одной реплики (Г-4)', () => {
  const moderate = () => ({ status: ModerationStatus.APPROVED, flags: [] });

  it('новая реплика оказывается и в сцене, и в озвучке', () => {
    const p = composeEditedPrompt(
      prompt(),
      snap(),
      'Марина, ты лучшая',
      [],
      'voiceover',
      moderate,
    );
    expect(p.finalText).toContain('Марина, ты лучшая');
    expect(p.finalVoiceoverScript).toBe('Марина, ты лучшая');
    expect(p.voiceoverScriptEdited).toBe('Марина, ты лучшая');
  });
  it('исходник модели сохраняется для сравнения', () => {
    const p = composeEditedPrompt(
      prompt(),
      snap(),
      'новый',
      [],
      'voiceover',
      moderate,
    );
    expect(p.generatedText).toBe('old scene');
    expect(p.voiceoverScript).toBe('старый текст');
  });
  it('флаг модерации снимает одобрение — startVideo откажет', () => {
    const p = composeEditedPrompt(null, snap(), 'x', [], 'voiceover', () => ({
      status: ModerationStatus.FLAGGED,
      flags: ['violence'],
    }));
    expect(p.approvedAt).toBeUndefined();
    expect(p.moderationFlags).toEqual(['violence']);
  });
});

describe('registerWarningFor — мягкое предупреждение §3.7', () => {
  it('праздничный текст при соболезновании — предупреждение, а не отказ', () => {
    expect(
      registerWarningFor(
        snap({ occasion: 'CONDOLENCE', tone: 'RESPECTFUL' }),
        'Ура!',
      ),
    ).toMatch(/Оставить как есть/);
  });
  it('у праздника предупреждения нет', () => {
    expect(registerWarningFor(snap(), 'Ура!')).toBeNull();
  });
});

// ── сервис ─────────────────────────────────────────────────────────────

function build(sessionOver: Record<string, unknown> = {}) {
  const store = new Map<string, Record<string, unknown>>();
  store.set('s1', {
    sessionId: 's1',
    userId: 'u1',
    projectId: 'p1',
    locale: 'ru',
    greetingBriefSnapshot: snap(),
    generationPrompt: prompt(),
    ...sessionOver,
  });
  let n = 1;
  const sessions = {
    getSession: jest.fn(async (id: string) => store.get(id)),
    updateSession: jest.fn(
      async (id: string, patch: Record<string, unknown>) => {
        const cur = store.get(id)!;
        const next = { ...cur };
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete next[k];
          else next[k] = v;
        }
        store.set(id, next);
        return next;
      },
    ),
    createSession: jest.fn(
      async (userId: string, seed: Record<string, unknown>, locale: string) => {
        const id = `s${++n}`;
        const row = { sessionId: id, userId, locale, ...seed };
        store.set(id, row);
        return row;
      },
    ),
    claimWork: jest.fn().mockResolvedValue(true),
    releaseWork: jest.fn().mockResolvedValue(undefined),
  };
  const projectBrief = {
    id: 'gb1',
    projectId: 'p1',
    occasion: 'BIRTHDAY',
    customOccasionText: null,
    recipientName: 'Марина',
    senderName: 'Андрей',
    tone: 'FUNNY',
    personalMessage: null,
    presenterProvider: 'grok',
    resolution: '720p',
    brandManifestId: null,
    occasionDate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const prisma = {
    greetingBrief: {
      findFirst: jest.fn().mockResolvedValue(projectBrief),
      update: jest.fn().mockResolvedValue(projectBrief),
    },
    brandManifest: { findFirst: jest.fn() },
  };
  const plans = { planOfUser: jest.fn().mockResolvedValue('PREMIUM') };
  const briefs = new GreetingBriefService(prisma as never, plans as never);
  const promptService = {
    moderateText: jest.fn(() => ({
      status: ModerationStatus.APPROVED,
      flags: [],
    })),
  };
  const blob = {
    copyBlob: jest.fn(
      async (_from: string, to: string): Promise<string | null> =>
        `https://blob/${to}`,
    ),
  };
  const service = new GreetingSessionEditService(
    sessions as never,
    briefs,
    promptService as never,
    blob as never,
  );
  return { service, store, sessions, prisma, blob };
}

describe('PATCH /sessions/:id/greeting-brief', () => {
  it('правка доходит до снимка СЕССИИ и до брифа проекта (Г-3)', async () => {
    const { service, store, prisma } = build();
    const r = await service.updateBrief('s1', {
      recipientName: 'Аня',
      tone: 'WARM',
    });
    expect(r.newVersion).toBe(false);
    const s = store.get('s1')!;
    expect(
      (s.greetingBriefSnapshot as GreetingBriefSnapshot).recipientName,
    ).toBe('Аня');
    expect(prisma.greetingBrief.update).toHaveBeenCalled();
    const data = prisma.greetingBrief.update.mock.calls[0][0].data;
    expect(data.recipientName).toBe('Аня');
  });

  it('смена смысла стирает собранный сценарий и сообщает об этом', async () => {
    const { service, store } = build();
    const r = await service.updateBrief('s1', { tone: 'WARM' });
    expect(r.promptCleared).toBe(true);
    expect(store.get('s1')!.generationPrompt).toBeUndefined();
  });

  it('смена качества видео сценарий не трогает', async () => {
    const { service, store } = build();
    const r = await service.updateBrief('s1', { resolution: '1080p' });
    expect(r.promptCleared).toBe(false);
    expect(store.get('s1')!.generationPrompt).toBeDefined();
  });

  it('шутливое соболезнование не проходит и этим путём', async () => {
    const { service, sessions } = build();
    await expect(
      service.updateBrief('s1', { occasion: 'CONDOLENCE' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('переход к соболезнованию сбрасывает наклейку и перечисляет сброшенное', async () => {
    const { service, store } = build({
      greetingBriefSnapshot: snap({ sticker: sticker() }),
    });
    const r = await service.updateBrief('s1', {
      occasion: 'CONDOLENCE',
      tone: 'RESPECTFUL',
    });
    expect(r.resetFields).toContain('sticker');
    expect(
      (store.get('s1')!.greetingBriefSnapshot as GreetingBriefSnapshot).sticker,
    ).toBeNull();
  });

  it('во время рендера — 409, ничего не записано', async () => {
    const { service, sessions, prisma } = build({
      generatedVideo: { status: GenerationStatus.PROCESSING },
    });
    await expect(
      service.updateBrief('s1', { tone: 'WARM' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(sessions.updateSession).not.toHaveBeenCalled();
    expect(prisma.greetingBrief.update).not.toHaveBeenCalled();
  });

  it('после готового ролика — новая версия, старая сессия не тронута', async () => {
    const { service, store, blob } = build({
      generatedVideo: { status: GenerationStatus.COMPLETE, videoUrl: 'v' },
      greetingBriefSnapshot: snap({ sticker: sticker() }),
    });
    const r = await service.updateBrief('s1', { recipientName: 'Аня' });
    expect(r.newVersion).toBe(true);
    expect(r.sessionId).not.toBe('s1');
    // Старая сессия как была.
    expect(
      (store.get('s1')!.greetingBriefSnapshot as GreetingBriefSnapshot)
        .recipientName,
    ).toBe('Марина');
    // Новая — с правкой и СВОЕЙ копией наклейки.
    const v = store.get(r.sessionId)!;
    const vs = v.greetingBriefSnapshot as GreetingBriefSnapshot;
    expect(vs.recipientName).toBe('Аня');
    expect(vs.sticker?.pathname).toBe(
      `sessions/${r.sessionId}/stickers/st1.png`,
    );
    expect(blob.copyBlob).toHaveBeenCalled();
    // Смысл поменялся (получатель) — сценарий не переносится.
    expect(v.generationPrompt).toBeUndefined();
  });

  it('новая версия без смены смысла переносит сценарий — платить заново незачем', async () => {
    const { service, store } = build({
      generatedVideo: { status: GenerationStatus.COMPLETE },
    });
    const r = await service.updateBrief('s1', { resolution: '1080p' });
    expect(store.get(r.sessionId)!.generationPrompt).toBeDefined();
  });

  it('занятый замок — 409, и бриф проекта НЕ изменён', async () => {
    const { service, sessions, prisma } = build();
    sessions.claimWork.mockResolvedValue(false);
    await expect(
      service.updateBrief('s1', { tone: 'WARM' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.greetingBrief.update).not.toHaveBeenCalled();
  });

  it('фото, не скопировавшееся в версию, названо, а сценарий не переносится', async () => {
    const { service, store, blob } = build({
      generatedVideo: { status: GenerationStatus.COMPLETE },
      greetingReferenceImages: [
        {
          id: 'i1',
          label: 'бабушка',
          description: null,
          photoUrl: 'u',
          photoPathname: 'sessions/s1/greeting-refs/i1/photo.jpg',
          createdAt: '2026-09-22T10:00:00Z',
        },
      ],
    });
    blob.copyBlob.mockResolvedValue(null);
    const r = await service.updateBrief('s1', { resolution: '1080p' });
    expect(r.resetFields).toContain('referenceImages');
    expect(r.promptCleared).toBe(true);
    expect(store.get(r.sessionId)!.generationPrompt).toBeUndefined();
  });

  it('бренд этим путём не меняется', async () => {
    const { service } = build();
    await expect(
      service.updateBrief('s1', { brandManifestId: 'bm1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PATCH /sessions/:id/greeting-script', () => {
  it('сцена и озвучка меняются вместе', async () => {
    const { service, store } = build();
    const r = await service.updateScript('s1', '  Марина, ты лучшая  ');
    const s = store.get('s1')!;
    const p = s.generationPrompt as {
      finalText: string;
      finalVoiceoverScript: string;
    };
    expect(p.finalVoiceoverScript).toBe('Марина, ты лучшая');
    expect(p.finalText).toContain('Марина, ты лучшая');
    expect(r.registerWarning).toBeNull();
    expect(r.registerMismatch).toBe(false);
  });

  /**
   * Найдено ревью этапа C: запись правки в `personalMessage` снимка
   * расходилась с брифом проекта, и следующее «Сохранить» брифа стирало
   * правку, а «Пересобрать» возвращало её слово в слово.
   */
  it('бриф не трогается — правка живёт в сценарии', async () => {
    const { service, store } = build();
    await service.updateScript('s1', 'Марина, ты лучшая');
    expect(
      (store.get('s1')!.greetingBriefSnapshot as GreetingBriefSnapshot)
        .personalMessage,
    ).toBeNull();
  });

  it('чужой образ отклоняется до записи', async () => {
    const { service, sessions } = build();
    await expect(
      service.updateScript('s1', 'Сделай как Илон Маск, голосом Илона Маска'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sessions.updateSession).not.toHaveBeenCalled();
  });

  it('пустой текст — 400', async () => {
    const { service } = build();
    await expect(service.updateScript('s1', '   ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('праздничный текст при трауре сохраняется, но с предупреждением', async () => {
    const { service } = build({
      greetingBriefSnapshot: snap({
        occasion: 'CONDOLENCE',
        tone: 'RESPECTFUL',
      }),
    });
    const r = await service.updateScript('s1', 'Поздравляем!');
    expect(r.registerWarning).toMatch(/празднично/);
    expect(r.registerMismatch).toBe(true);
  });

  it('после готового ролика — в новую версию', async () => {
    const { service, store } = build({
      generatedVideo: { status: GenerationStatus.COMPLETE },
    });
    const r = await service.updateScript('s1', 'Новый текст');
    expect(r.newVersion).toBe(true);
    expect(
      (store.get('s1')!.generationPrompt as { finalVoiceoverScript: string })
        .finalVoiceoverScript,
    ).toBe('старый текст');
    expect(
      (
        store.get(r.sessionId)!.generationPrompt as {
          finalVoiceoverScript: string;
        }
      ).finalVoiceoverScript,
    ).toBe('Новый текст');
  });

  it('во время рендера — 409', async () => {
    const { service } = build({
      generatedVideo: { status: GenerationStatus.PENDING },
    });
    await expect(service.updateScript('s1', 'x y z')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

/**
 * Этап D (§3.4 п.1, приёмка §8.1): правка из сессии идёт через тот же
 * `resolveNext`, поэтому и здесь OTHER без ответа о настроении не
 * сохраняется — ни в снимок сессии, ни в бриф проекта.
 */
describe('PATCH /sessions/:id/greeting-brief — OTHER требует ответа о настроении', () => {
  const otherSnap = (over: Partial<GreetingBriefSnapshot> = {}) =>
    snap({
      occasion: 'OTHER',
      customOccasionText: 'Защита диплома',
      tone: 'WARM',
      ...over,
    });

  it('старый снимок OTHER без ответа — 400, ничего не записано', async () => {
    const { service, sessions, prisma } = build({
      greetingBriefSnapshot: otherSnap(),
    });
    await expect(
      service.updateBrief('s1', { recipientName: 'Аня' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sessions.updateSession).not.toHaveBeenCalled();
    expect(prisma.greetingBrief.update).not.toHaveBeenCalled();
  });

  it('с ответом — снимок и бриф проекта получают регистр человека', async () => {
    const { service, store, prisma } = build({
      greetingBriefSnapshot: otherSnap(),
    });
    await service.updateBrief('s1', {
      recipientName: 'Аня',
      occasionRegister: 'SOLEMN',
    });
    const s = store.get('s1')!.greetingBriefSnapshot as GreetingBriefSnapshot;
    expect(s.occasionRegister).toBe('SOLEMN');
    expect(s.registerSource).toBe('user');
    expect(prisma.greetingBrief.update.mock.calls[0][0].data).toMatchObject({
      occasionRegister: 'SOLEMN',
      registerSource: 'user',
    });
  });
});

/**
 * Этап D, «Открыто осознанно» §12: ответ человека хранится в снимке
 * отдельно от итога. Поднятый словами снимок правится без повторного
 * ответа, а старый снимок без поля читается по `registerSource`.
 */
describe('PATCH /sessions/:id/greeting-brief — ответ о настроении отдельно от итога', () => {
  const raisedSnap = (over: Partial<GreetingBriefSnapshot> = {}) =>
    snap({
      occasion: 'OTHER',
      customOccasionText: 'Поминки деда',
      tone: 'RESPECTFUL',
      occasionRegister: 'MOURNING',
      registerSource: 'keywords',
      userOccasionRegister: 'SOLEMN',
      ...over,
    });

  it('поднятый снимок правится без ответа; ответ — и в снимке, и в брифе', async () => {
    const { service, store, prisma } = build({
      greetingBriefSnapshot: raisedSnap(),
    });
    await service.updateBrief('s1', { recipientName: 'Аня' });
    const s = store.get('s1')!.greetingBriefSnapshot as GreetingBriefSnapshot;
    expect(s.occasionRegister).toBe('MOURNING');
    expect(s.userOccasionRegister).toBe('SOLEMN');
    expect(prisma.greetingBrief.update.mock.calls[0][0].data).toMatchObject({
      occasionRegister: 'MOURNING',
      userOccasionRegister: 'SOLEMN',
    });
  });

  it('описание переписано, подъём снят — итог по ответу, а не по умолчанию', async () => {
    const { service, store } = build({ greetingBriefSnapshot: raisedSnap() });
    await service.updateBrief('s1', { customOccasionText: 'Юбилей деда' });
    const s = store.get('s1')!.greetingBriefSnapshot as GreetingBriefSnapshot;
    expect(s.occasionRegister).toBe('SOLEMN');
    expect(s.registerSource).toBe('user');
  });

  it('старый снимок без поля, источник user — ответ восстановлен', async () => {
    const { service, store } = build({
      greetingBriefSnapshot: raisedSnap({
        customOccasionText: 'Защита диплома',
        tone: 'WARM',
        occasionRegister: 'SOLEMN',
        registerSource: 'user',
        userOccasionRegister: undefined,
      }),
    });
    await service.updateBrief('s1', { recipientName: 'Аня' });
    const s = store.get('s1')!.greetingBriefSnapshot as GreetingBriefSnapshot;
    expect(s.occasionRegister).toBe('SOLEMN');
    expect(s.userOccasionRegister).toBe('SOLEMN');
  });
});
