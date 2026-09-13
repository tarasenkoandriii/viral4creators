/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ExportService } from './export.service';
import { PostProdError } from '../../common/postprod';
import {
  GeneratedVideo,
  GenerationStatus,
} from '../../common/types/generation.types';
import { Session } from '../../common/types/session.types';

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
};

function plainSession(over: Partial<Session> = {}): Session {
  return {
    sessionId: 's1',
    createdAt: new Date(),
    lastActivityAt: new Date(),
    status: 'ready' as any,
    userId: 'u1',
    locale: 'ru',
    generatedVideo: VIDEO,
    generationPrompt: {
      finalText: 'Купите прямо сейчас',
      approvedAt: new Date(),
    } as any,
    ...over,
  } as Session;
}

function build(
  over: {
    session?: Session;
    noSession?: boolean;
    denied?: string;
    postprodStartError?: Error;
    exportClaimed?: boolean;
  } = {},
) {
  const sessions = {
    getSession: jest
      .fn()
      .mockResolvedValue(
        over.noSession ? undefined : (over.session ?? plainSession()),
      ),
    updateSession: jest
      .fn()
      .mockImplementation((_id: string, patch: Partial<Session>) =>
        Promise.resolve({ ...plainSession(), ...patch }),
      ),
    createSession: jest
      .fn()
      .mockResolvedValue(plainSession({ sessionId: 'child-1' })),
    // Автоэкспорт, ярус B (Е-2.1 шестого аудита) — по умолчанию замок
    // всегда свободен, чтобы существующие тесты startRerender/syncStatus
    // (написанные до этой правки) проходили как раньше.
    claimWork: jest.fn().mockResolvedValue(over.exportClaimed ?? true),
    releaseWork: jest.fn().mockResolvedValue(undefined),
    // Крон-аналог advanceGenerating (Е-2.3) — по умолчанию ничего не
    // находит, тесты runSyncTick переопределяют явно.
    findSessionsWithPendingTierBExport: jest.fn().mockResolvedValue([]),
  };
  const plans = {
    assertSession: jest
      .fn()
      .mockImplementation(() =>
        over.denied
          ? Promise.reject(new Error(over.denied))
          : Promise.resolve(),
      ),
  };
  const prompt = {
    seedPrompt: jest.fn().mockResolvedValue(undefined),
    approvePrompt: jest.fn().mockResolvedValue(undefined),
  };
  const generation = {
    generateVideo: jest.fn().mockResolvedValue(undefined),
    getVideoStatus: jest.fn().mockResolvedValue(VIDEO),
  };
  const postprod = {
    startExport: over.postprodStartError
      ? jest.fn().mockRejectedValue(over.postprodStartError)
      : jest.fn().mockResolvedValue({
          ...VIDEO,
          exportJobId: 'job1',
          exportVariants: [
            { format: '1:1', tier: 'A', status: 'pending', requestedAt: 'x' },
          ],
        }),
    pollExport: jest
      .fn()
      .mockImplementation((_id: string, v: GeneratedVideo) =>
        Promise.resolve(v),
      ),
  };
  return {
    svc: new ExportService(
      sessions as any,
      plans as any,
      prompt as any,
      generation as any,
      postprod as any,
    ),
    sessions,
    plans,
    prompt,
    generation,
    postprod,
  };
}

describe('ExportService (TODO §35, doc/MULTI-FORMAT-EXPORT-SPEC.md, этап 75)', () => {
  describe('startBatch — ярус A', () => {
    it('нет сессии — 404', async () => {
      const { svc } = build({ noSession: true });
      await expect(svc.startBatch('s1', ['tiktok'])).rejects.toThrow(
        NotFoundException,
      );
    });

    it('ролик ещё не готов — 400, автоэкспорт только для готового', async () => {
      const { svc } = build({
        session: plainSession({
          generatedVideo: { ...VIDEO, status: GenerationStatus.PROCESSING },
        }),
      });
      await expect(svc.startBatch('s1', ['tiktok'])).rejects.toThrow(
        BadRequestException,
      );
    });

    it('гейт плана проверяется до похода в PostProductionService', async () => {
      const { svc, postprod } = build({ denied: 'нужен план Standard' });
      await expect(svc.startBatch('s1', ['tiktok'])).rejects.toThrow(
        'нужен план Standard',
      );
      expect(postprod.startExport).not.toHaveBeenCalled();
    });

    it('резолвит пресеты в форматы перед вызовом PostProductionService', async () => {
      const { svc, postprod } = build();
      await svc.startBatch('s1', ['tiktok', 'square']);
      expect(postprod.startExport).toHaveBeenCalledWith('s1', VIDEO, [
        '9:16',
        '1:1',
      ]);
    });

    it('голый формат (не пресет) передаётся как есть', async () => {
      const { svc, postprod } = build();
      await svc.startBatch('s1', ['3:4']);
      expect(postprod.startExport).toHaveBeenCalledWith('s1', VIDEO, ['3:4']);
    });

    it('PostProdError оборачивается в BadRequestException, не 500', async () => {
      const { svc } = build({
        postprodStartError: new PostProdError('формат из другого семейства'),
      });
      await expect(svc.startBatch('s1', ['16:9'])).rejects.toThrow(
        BadRequestException,
      );
      await expect(svc.startBatch('s1', ['16:9'])).rejects.toThrow(
        'формат из другого семейства',
      );
    });

    it('прочая ошибка PostProductionService не глотается и не перекрашивается', async () => {
      const boom = new Error('прочая ошибка инфраструктуры');
      const { svc } = build({ postprodStartError: boom });
      await expect(svc.startBatch('s1', ['tiktok'])).rejects.toBe(boom);
    });

    it('проставляет preset на созданные варианты по формату', async () => {
      const { svc, sessions } = build();
      const r = await svc.startBatch('s1', ['square']); // format '1:1'
      expect(r.exportVariants?.[0].preset).toBe('square');
      expect(sessions.updateSession).toHaveBeenCalledTimes(1);
    });

    it('голый формат без пресета — preset не проставляется, без лишнего updateSession', async () => {
      const { svc } = build();
      const r = await svc.startBatch('s1', ['3:4']);
      // postprod mock всегда возвращает вариант '1:1' — раз запрошенного
      // формата '3:4' нет среди byFormat ключей, preset-лейбл ставить
      // некому, но метод не обязан пропускать шаг сохранения.
      expect(r.exportVariants?.[0].preset).toBeUndefined();
    });
  });

  describe('startRerender — ярус B', () => {
    it('формат того же семейства, что уже отрендерен — 400 с указанием на дешёвый /export', async () => {
      // VIDEO.renderedAspectRatio === '9:16' — запрос '3:4' (тоже семейство 9:16) отвергается.
      const { svc } = build();
      await expect(
        svc.startRerender('s1', '3:4', undefined, undefined),
      ).rejects.toThrow('POST /export');
    });

    it('формат уже запрошен (не failed) — 400, второй раз не заказываем', async () => {
      const { svc } = build({
        session: plainSession({
          generatedVideo: {
            ...VIDEO,
            exportVariants: [
              {
                format: '16:9',
                tier: 'B',
                status: 'pending',
                requestedAt: 'x',
                childSessionId: 'child-old',
              },
            ],
          },
        }),
      });
      await expect(
        svc.startRerender('s1', '16:9', undefined, undefined),
      ).rejects.toThrow('уже запрошен');
    });

    it('ранее упавший вариант того же формата НЕ блокирует повторный запрос', async () => {
      const { svc, generation } = build({
        session: plainSession({
          generatedVideo: {
            ...VIDEO,
            exportVariants: [
              {
                format: '16:9',
                tier: 'B',
                status: 'failed',
                requestedAt: 'x',
                error: 'что-то пошло не так',
              },
            ],
          },
        }),
      });
      await svc.startRerender('s1', '16:9', undefined, undefined);
      expect(generation.generateVideo).toHaveBeenCalled();
    });

    it('нет одобренного промпта — 400, перерендер копирует именно его', async () => {
      const { svc } = build({
        session: plainSession({ generationPrompt: { finalText: 'x' } as any }),
      });
      await expect(
        svc.startRerender('s1', '16:9', undefined, undefined),
      ).rejects.toThrow('одобренного промпта');
    });

    it('проектная сессия — дочерняя сессия создаётся с полным seed', async () => {
      const { svc, sessions } = build({
        session: plainSession({
          projectId: 'p1',
          productItemId: 'i1',
          productInformation: { name: 'Товар' } as any,
        }),
      });
      await svc.startRerender('s1', '16:9', 'youtube', undefined);
      expect(sessions.createSession).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ projectId: 'p1', productItemId: 'i1' }),
        'ru',
      );
      // Проектный путь несёт данные через seed — второй updateSession на
      // дочернюю сессию для productInformation/brandManifestSnapshot не нужен.
      expect(sessions.updateSession).not.toHaveBeenCalledWith(
        'child-1',
        expect.anything(),
      );
    });

    it('обычная (не проектная) сессия — seed не используется, данные копируются отдельным updateSession', async () => {
      const { svc, sessions } = build({
        session: plainSession({
          productInformation: { name: 'Товар' } as any,
          brandManifestSnapshot: { voiceMode: 'veo' } as any,
        }),
      });
      await svc.startRerender('s1', '16:9', undefined, undefined);
      expect(sessions.createSession).toHaveBeenCalledWith(
        'u1',
        undefined,
        'ru',
      );
      expect(sessions.updateSession).toHaveBeenCalledWith(
        'child-1',
        expect.objectContaining({
          productInformation: { name: 'Товар' },
          brandManifestSnapshot: { voiceMode: 'veo' },
        }),
      );
    });

    it('успех — вызывает generateVideo с целевым форматом и записывает вариант B с childSessionId', async () => {
      const { svc, generation, sessions } = build();
      const r = await svc.startRerender('s1', '16:9', 'youtube', 'standard');
      expect(generation.generateVideo).toHaveBeenCalledWith(
        'child-1',
        'standard',
        '16:9',
        undefined,
        undefined,
        undefined,
      );
      expect(r.childSessionId).toBe('child-1');
      const savedVariant = sessions.updateSession.mock.calls
        .at(-1)?.[1]
        .generatedVideo.exportVariants.at(-1);
      expect(savedVariant).toMatchObject({
        format: '16:9',
        preset: 'youtube',
        tier: 'B',
        status: 'pending',
        childSessionId: 'child-1',
      });
    });

    // Доп. запрос владельца продукта (ТЗ §9, этап 4 плана §14) — найдено
    // при ПОВТОРНОМ аудите: та же находка, что уже была для
    // provider/resolution — переэкспорт цепочки Scene Extension в
    // другой формат без этого поля тихо давал бы обычные 8 секунд
    // вместо той же итоговой длины в новом формате.
    it('переэкспорт цепочки Scene Extension — сохраняет chainTargetDurationSeconds в новом формате', async () => {
      const { svc, generation } = build({
        session: plainSession({
          generatedVideo: {
            ...VIDEO,
            chainSegmentsDone: 7,
            chainSegmentsTotal: 7,
            chainTargetDurationSeconds: 56,
          },
        }),
      });
      await svc.startRerender('s1', '16:9', 'youtube', 'standard');
      expect(generation.generateVideo).toHaveBeenCalledWith(
        'child-1',
        'standard',
        '16:9',
        undefined,
        undefined,
        56,
      );
    });

    it('отказ generateVideo (гейт/лимит/блокировка) доходит до пользователя, а не глотается', async () => {
      const { svc, generation } = build();
      generation.generateVideo.mockRejectedValue(
        new Error('дневной лимит исчерпан'),
      );
      await expect(
        svc.startRerender('s1', '16:9', undefined, undefined),
      ).rejects.toThrow('дневной лимит исчерпан');
    });

    it('Е-2.1 шестого аудита: замок занят параллельным запросом — отказ, дочерняя сессия не создаётся, generateVideo не платит', async () => {
      const { svc, sessions, generation } = build({ exportClaimed: false });
      await expect(
        svc.startRerender('s1', '16:9', undefined, undefined),
      ).rejects.toThrow('уже выполняется');
      expect(sessions.createSession).not.toHaveBeenCalled();
      expect(generation.generateVideo).not.toHaveBeenCalled();
    });

    it('Е-2.1: свежее чтение под замком видит формат, уже запрошенный параллельным запросом (записанный между снимком и захватом) — второй отказывает, не платит дважды', async () => {
      const { svc, sessions, generation } = build();
      // Первое чтение (ownSessionWithVideo, до захвата замка) — чистый
      // снимок, пре-проверка "уже запрошен" его пропускает. Второе (под
      // замком) — уже с вариантом, который успел записать параллельный
      // запрос, пока мы ждали захват.
      sessions.getSession
        .mockResolvedValueOnce(plainSession())
        .mockResolvedValueOnce(
          plainSession({
            generatedVideo: {
              ...VIDEO,
              exportVariants: [
                {
                  format: '16:9',
                  tier: 'B',
                  status: 'pending',
                  requestedAt: 'x',
                  childSessionId: 'child-other',
                },
              ],
            },
          }),
        );
      await expect(
        svc.startRerender('s1', '16:9', undefined, undefined),
      ).rejects.toThrow('уже запрошен параллельным запросом');
      expect(sessions.createSession).not.toHaveBeenCalled();
      expect(generation.generateVideo).not.toHaveBeenCalled();
    });
  });

  describe('syncStatus', () => {
    it('нет сессии — 404', async () => {
      const { svc } = build({ noSession: true });
      await expect(svc.syncStatus('s1')).rejects.toThrow(NotFoundException);
    });

    it('нет видео вовсе — 404', async () => {
      const { svc } = build({
        session: plainSession({ generatedVideo: undefined }),
      });
      await expect(svc.syncStatus('s1')).rejects.toThrow(NotFoundException);
    });

    it('нет ожидающих вариантов яруса B — только pollExport яруса A, без опроса дочерних сессий', async () => {
      const { svc, postprod, generation } = build();
      await svc.syncStatus('s1');
      expect(postprod.pollExport).toHaveBeenCalledWith('s1', VIDEO);
      expect(generation.getVideoStatus).not.toHaveBeenCalled();
    });

    it('дочерняя сессия завершена и постобработана — вариант B становится complete', async () => {
      const video: GeneratedVideo = {
        ...VIDEO,
        exportVariants: [
          {
            format: '16:9',
            tier: 'B',
            status: 'pending',
            requestedAt: 'x',
            childSessionId: 'child-1',
          },
        ],
      };
      const { svc, generation, sessions } = build({
        session: plainSession({ generatedVideo: video }),
      });
      generation.getVideoStatus.mockResolvedValue({
        ...VIDEO,
        status: GenerationStatus.COMPLETE,
        postStatus: 'complete',
        postPathname: 'sessions/child-1/generated.mp4',
        downloadUrl: 'https://blob.test/sessions/child-1/generated.mp4',
      });
      const r = await svc.syncStatus('s1');
      expect(r.exportVariants?.[0].status).toBe('complete');
      expect(r.exportVariants?.[0].url).toBe(
        'https://blob.test/sessions/child-1/generated.mp4',
      );
      expect(sessions.updateSession).toHaveBeenCalled();
    });

    it('дочерняя сессия завершила рендер, но своя постобработка ещё pending — вариант остаётся pending', async () => {
      const video: GeneratedVideo = {
        ...VIDEO,
        exportVariants: [
          {
            format: '16:9',
            tier: 'B',
            status: 'pending',
            requestedAt: 'x',
            childSessionId: 'child-1',
          },
        ],
      };
      const { svc, generation, sessions } = build({
        session: plainSession({ generatedVideo: video }),
      });
      generation.getVideoStatus.mockResolvedValue({
        ...VIDEO,
        status: GenerationStatus.COMPLETE,
        postStatus: 'pending',
      });
      const r = await svc.syncStatus('s1');
      expect(r.exportVariants?.[0].status).toBe('pending');
      expect(sessions.updateSession).not.toHaveBeenCalled();
    });

    it('дочерняя сессия провалилась — вариант B становится failed с текстом ошибки', async () => {
      const video: GeneratedVideo = {
        ...VIDEO,
        exportVariants: [
          {
            format: '16:9',
            tier: 'B',
            status: 'pending',
            requestedAt: 'x',
            childSessionId: 'child-1',
          },
        ],
      };
      const { svc, generation } = build({
        session: plainSession({ generatedVideo: video }),
      });
      generation.getVideoStatus.mockResolvedValue({
        ...VIDEO,
        status: GenerationStatus.FAILED,
        error: { message: 'Veo вернул ошибку' },
      });
      const r = await svc.syncStatus('s1');
      expect(r.exportVariants?.[0]).toMatchObject({
        status: 'failed',
        error: 'Veo вернул ошибку',
      });
    });

    it('дочерняя сессия временно недоступна — вариант не трогаем, следующий опрос повторит', async () => {
      const video: GeneratedVideo = {
        ...VIDEO,
        exportVariants: [
          {
            format: '16:9',
            tier: 'B',
            status: 'pending',
            requestedAt: 'x',
            childSessionId: 'child-1',
          },
        ],
      };
      const { svc, generation, sessions } = build({
        session: plainSession({ generatedVideo: video }),
      });
      generation.getVideoStatus.mockRejectedValue(new Error('ETIMEDOUT'));
      const r = await svc.syncStatus('s1');
      expect(r.exportVariants?.[0].status).toBe('pending');
      expect(sessions.updateSession).not.toHaveBeenCalled();
    });

    it('уже complete/failed варианты яруса B не переопрашиваются повторно', async () => {
      const video: GeneratedVideo = {
        ...VIDEO,
        exportVariants: [
          {
            format: '16:9',
            tier: 'B',
            status: 'complete',
            requestedAt: 'x',
            childSessionId: 'child-1',
            url: 'https://blob.test/done.mp4',
          },
        ],
      };
      const { svc, generation } = build({
        session: plainSession({ generatedVideo: video }),
      });
      await svc.syncStatus('s1');
      expect(generation.getVideoStatus).not.toHaveBeenCalled();
    });

    it('Е-2.1 шестого аудита: замок занят параллельным syncStatus — возвращает video без записи, результат не теряется молча', async () => {
      const video: GeneratedVideo = {
        ...VIDEO,
        exportVariants: [
          {
            format: '16:9',
            tier: 'B',
            status: 'pending',
            requestedAt: 'x',
            childSessionId: 'child-1',
          },
        ],
      };
      const { svc, generation, sessions } = build({
        session: plainSession({ generatedVideo: video }),
        exportClaimed: false,
      });
      generation.getVideoStatus.mockResolvedValue({
        ...VIDEO,
        status: GenerationStatus.COMPLETE,
        postStatus: 'complete',
      });
      const r = await svc.syncStatus('s1');
      expect(sessions.updateSession).not.toHaveBeenCalled();
      // Ничего не потеряно — результат просто не записан ЭТИМ вызовом,
      // следующий опрос повторит getVideoStatus и получит тот же ответ.
      expect(r.exportVariants?.[0].status).toBe('pending');
    });

    it('Е-2.1: свежее чтение под замком сливает по childSessionId, даже если состав массива изменился (новый вариант добавлен параллельно)', async () => {
      const video: GeneratedVideo = {
        ...VIDEO,
        exportVariants: [
          {
            format: '16:9',
            tier: 'B',
            status: 'pending',
            requestedAt: 'x',
            childSessionId: 'child-1',
          },
        ],
      };
      const { svc, generation, sessions } = build({
        session: plainSession({ generatedVideo: video }),
      });
      generation.getVideoStatus.mockResolvedValue({
        ...VIDEO,
        status: GenerationStatus.COMPLETE,
        postStatus: 'complete',
        downloadUrl: 'https://blob.test/child-1.mp4',
      });
      // Второе чтение (под замком) видит ДОПОЛНИТЕЛЬНЫЙ вариант,
      // записанный параллельным startRerender между первым чтением и
      // захватом замка — слияние по childSessionId не должно его
      // потерять.
      sessions.getSession.mockResolvedValueOnce(
        plainSession({ generatedVideo: video }),
      );
      sessions.getSession.mockResolvedValueOnce(
        plainSession({
          generatedVideo: {
            ...video,
            exportVariants: [
              ...video.exportVariants!,
              {
                format: '1:1',
                tier: 'B',
                status: 'pending',
                requestedAt: 'y',
                childSessionId: 'child-2',
              },
            ],
          },
        }),
      );
      const r = await svc.syncStatus('s1');
      expect(r.exportVariants).toHaveLength(2);
      expect(
        r.exportVariants?.find((v) => v.childSessionId === 'child-1'),
      ).toMatchObject({ status: 'complete' });
      expect(
        r.exportVariants?.find((v) => v.childSessionId === 'child-2'),
      ).toMatchObject({ status: 'pending' });
    });
  });

  describe('runSyncTick — крон-аналог advanceGenerating для яруса B (Е-2.3 шестого аудита, этап 76)', () => {
    it('ничего не найдено — checked: 0, syncStatus не вызывается', async () => {
      const { svc, sessions } = build();
      const spy = jest.spyOn(svc, 'syncStatus');
      const r = await svc.runSyncTick(50);
      expect(r).toEqual({ checked: 0, failed: 0 });
      expect(sessions.findSessionsWithPendingTierBExport).toHaveBeenCalledWith(
        50,
      );
      expect(spy).not.toHaveBeenCalled();
    });

    it('досматривает каждую найденную сессию', async () => {
      const { svc, sessions } = build();
      sessions.findSessionsWithPendingTierBExport.mockResolvedValue([
        's1',
        's2',
      ]);
      const spy = jest.spyOn(svc, 'syncStatus').mockResolvedValue(VIDEO);
      const r = await svc.runSyncTick(50);
      expect(r).toEqual({ checked: 2, failed: 0 });
      expect(spy).toHaveBeenCalledWith('s1');
      expect(spy).toHaveBeenCalledWith('s2');
    });

    it('одна сессия падает — не роняет весь тик, остальные досматриваются', async () => {
      const { svc, sessions } = build();
      sessions.findSessionsWithPendingTierBExport.mockResolvedValue([
        's1',
        's2',
        's3',
      ]);
      const spy = jest
        .spyOn(svc, 'syncStatus')
        .mockImplementation(async (id: string) => {
          if (id === 's2') throw new Error('boom');
          return VIDEO;
        });
      const r = await svc.runSyncTick(50);
      expect(r).toEqual({ checked: 3, failed: 1 });
      expect(spy).toHaveBeenCalledTimes(3);
    });

    it('лимит по умолчанию — EXPORT_SYNC_BATCH', async () => {
      const { svc, sessions } = build();
      await svc.runSyncTick();
      expect(sessions.findSessionsWithPendingTierBExport).toHaveBeenCalledWith(
        50,
      );
    });
  });
});
