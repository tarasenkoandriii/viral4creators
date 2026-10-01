/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые двойники: подставляем заглушки на месте зависимостей, форму которых тест не проверяет */
/**
 * Пятый аудит (doc/AUDIT-2026-09-09-round5.md, Д-... тест-план в
 * `doc/WORKFLOW-FUNNEL-SPEC.md` §9 и `doc/WORKFLOW-FUNNEL-COHORT-
 * CONVERSION-SPEC.md` §9) явно требовал этот файл — маршрут требует
 * `assertOperator`, как и остальные семнадцать в `AdminPanelController`.
 * У контроллера в целом нет отдельного файла тестов (все 19 маршрутов
 * — тонкая обвязка над сервисами, которые тестируются сами по себе), но
 * два новых маршрута воронки (этап 78) были явно названы в тест-плане
 * обоих ТЗ — этот файл закрывает именно их, не весь контроллер целиком
 * (это отдельная, более крупная задача сама по себе, см. TODO).
 *
 * Проверяем ровно то, что нельзя проверить в `admin-panel.service.spec.ts`
 * (там `assertOperator` тестируется в изоляции, без маршрута вокруг):
 * что оба HTTP-хендлера реально ЗОВУТ `assertOperator` ПЕРЕД обращением
 * к данным, и что отказ `assertOperator` (не-оператор) останавливает
 * запрос до вызова `getWorkflowFunnel`/`getWorkflowCohortConversion` —
 * то есть данные воронки не могут утечь мимо проверки роли даже если
 * кто-то по ошибке поменяет порядок строк в контроллере.
 */

// `AdminPanelController` импортирует `AdminSessionGuard` (для типа
// `AdminAuthenticatedRequest`), а тот — `PrismaService`, которая в
// песочнице не может собрать `@prisma/client` (нет сети до
// binaries.prisma.sh). Тот же обход, что уже применяет
// `cron.controller.spec.ts` — подменяем модуль до импорта контроллера,
// сервис в этом файле никак не используется по существу.
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
// `AdminPanelController` импортирует ЗНАЧЕНИЕ `AdminPanelService`
// (не только тип) — реальный файл сервиса тоже тянет `@prisma/client`
// напрямую (enum `WorkflowKind`). Мокаем и его — в этом файле нужен
// только конструктор-заглушка, реальную логику сервиса тестирует
// `admin-panel.service.spec.ts`.
jest.mock('./admin-panel.service', () => ({ AdminPanelService: class {} }));
// Тот же класс проблемы дальше по цепочке импортов контроллера (через
// `AdminUsersService`/`AiUsageService`/др.) — мокаем корневые модули,
// которые реально тянут `@prisma/client`, той же техникой, что уже
// применяет `cron.controller.spec.ts` для похожей цепочки.
jest.mock('../../common/session.service', () => ({ SessionService: class {} }));

import { ForbiddenException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  AdminPanelController,
  RevokeWithReasonDto,
} from './admin-panel.controller';
import type { AdminAuthenticatedRequest } from '../admin-auth/admin-session.guard';

function build() {
  const adminPanel = {
    assertOperator: jest.fn().mockResolvedValue(undefined),
    getWorkflowFunnel: jest.fn().mockResolvedValue({ funnel: 'stub' }),
    getWorkflowCohortConversion: jest
      .fn()
      .mockResolvedValue({ cohort: 'stub' }),
    listSessions: jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    }),
  };
  // Остальные зависимости контроллера не участвуют ни в одном из
  // проверяемых маршрутов — им намеренно ничего не подставляем
  // (реальный вызов через них бросил бы TypeError, что и подтверждает,
  // что тест не задевает чужую логику).
  const voiceoverSettings = {
    get: jest.fn(),
    setDefault: jest.fn(),
  };
  const musicCatalog = {
    get: jest.fn(),
    save: jest.fn(),
  };
  const balances = { list: jest.fn().mockResolvedValue([]) };
  // Этап 135: вкладка «Приглашения» и два действия оператора. `users`
  // здесь больше не заглушка — оба действия возвращают свежую карточку
  // пользователя, и это часть их контракта.
  const users = {
    get: jest.fn().mockResolvedValue({ id: 'u1' }),
    briefs: jest.fn().mockResolvedValue([]),
  };
  // Аватары плашек пользователя — последний параметр конструктора.
  const avatars = { avatar: jest.fn().mockResolvedValue(null) };
  const referrals = {
    overview: jest.fn().mockResolvedValue({ window: 'week' }),
    revokeReferral: jest.fn().mockResolvedValue({ revoked: true }),
  };
  const liteUnlock = {
    revoke: jest.fn().mockResolvedValue(undefined),
    grantByOperator: jest.fn().mockResolvedValue(undefined),
  };
  const testTickets = {
    list: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue({ id: 't1' }),
    progress: jest.fn().mockResolvedValue([]),
    setStatus: jest.fn().mockResolvedValue({ id: 't1' }),
    reply: jest.fn().mockResolvedValue({ id: 't1' }),
  };
  const audioSeparation = {
    view: jest.fn().mockResolvedValue({ state: 'off' }),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const tutorialLocales = {
    get: jest.fn().mockResolvedValue({ locales: ['ru'] }),
    set: jest.fn().mockResolvedValue({ locales: ['ru', 'en'] }),
  };
  const tutorialVoice = {
    view: jest.fn().mockResolvedValue({ enabled: false, voiceId: null }),
    set: jest.fn().mockResolvedValue({ enabled: true, voiceId: null }),
  };
  const speechRecognition = {
    get: jest.fn().mockResolvedValue({ active: 'gemini' }),
    set: jest.fn().mockResolvedValue({ active: 'soniox' }),
  };
  const voiceAssistant = {
    view: jest.fn().mockResolvedValue({ caps: {} }),
    set: jest.fn().mockResolvedValue({ caps: {} }),
  };
  const personaLookQuota = {
    view: jest.fn().mockResolvedValue({}),
    set: jest.fn().mockResolvedValue({}),
  };
  const controller = new AdminPanelController(
    adminPanel as any,
    // Этап 155: приглашения тестировщиков — второй параметр.
    undefined as any,
    // Этап 158: очередь находок — третий.
    testTickets as any,
    users as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    voiceoverSettings as any,
    musicCatalog as any,
    balances as any,
    // aiGuide, wizardTelemetry, wizardExperience, analysisSettings,
    // videoProviderSettings,
    // grokTransportSettings — этих маршрутов тест не трогает. Число
    // заглушек обязано совпадать с числом параметров конструктора:
    // арность проверяет шаг «типы» в CI (корневой tsconfig видит
    // спеки), а `jest` с `diagnostics: false` — нет.
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined as any,
    referrals as any,
    liteUnlock as any,
    // Выключатель «Фон при дубляже» (этап E ТЗ
    // TZ-Voice-Replace-Keep-Background.md) — последний параметр.
    audioSeparation as any,
    tutorialVoice as any,
    tutorialLocales as any,
    speechRecognition as any,
    voiceAssistant as any,
    // «Квота образов «Я в кадре»» (этап F).
    personaLookQuota as any,
    // Аватары плашек пользователя — последний параметр.
    avatars as any,
  );
  const req = { userId: 'op-1' } as AdminAuthenticatedRequest;
  return {
    controller,
    adminPanel,
    voiceoverSettings,
    musicCatalog,
    balances,
    users,
    referrals,
    liteUnlock,
    testTickets,
    audioSeparation,
    tutorialVoice,
    tutorialLocales,
    speechRecognition,
    voiceAssistant,
    personaLookQuota,
    avatars,
    req,
  };
}

describe('AdminPanelController — /admin/workflow-funnel*', () => {
  it('GET /admin/workflow-funnel: требует assertOperator до обращения к данным', async () => {
    const { controller, adminPanel, req } = build();
    const callOrder: string[] = [];
    adminPanel.assertOperator.mockImplementation(async () => {
      callOrder.push('assertOperator');
    });
    adminPanel.getWorkflowFunnel.mockImplementation(async () => {
      callOrder.push('getWorkflowFunnel');
      return { funnel: 'stub' };
    });

    const result = await controller.workflowFunnel(req, 'day');

    expect(adminPanel.assertOperator).toHaveBeenCalledWith('op-1');
    expect(callOrder).toEqual(['assertOperator', 'getWorkflowFunnel']);
    expect(result).toEqual({ funnel: 'stub' });
  });

  it('GET /admin/workflow-funnel: отказ assertOperator останавливает запрос — сервис данных не зовётся', async () => {
    const { controller, adminPanel, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new ForbiddenException());

    await expect(controller.workflowFunnel(req, 'day')).rejects.toThrow(
      ForbiddenException,
    );
    expect(adminPanel.getWorkflowFunnel).not.toHaveBeenCalled();
  });

  it('GET /admin/workflow-funnel: валидный `window` передаётся как есть', async () => {
    const { controller, adminPanel, req } = build();
    await controller.workflowFunnel(req, 'week');
    expect(adminPanel.getWorkflowFunnel).toHaveBeenCalledWith('week');
  });

  it.each([
    ['не передан', undefined],
    ['мусорное значение', 'fortnight'],
  ])(
    'GET /admin/workflow-funnel: %s → дефолт "day", а не падение/undefined',
    async (_label, value) => {
      const { controller, adminPanel, req } = build();
      await controller.workflowFunnel(req, value);
      expect(adminPanel.getWorkflowFunnel).toHaveBeenCalledWith('day');
    },
  );

  it('GET /admin/workflow-funnel/cohort-conversion: требует assertOperator до обращения к данным', async () => {
    const { controller, adminPanel, req } = build();
    const callOrder: string[] = [];
    adminPanel.assertOperator.mockImplementation(async () => {
      callOrder.push('assertOperator');
    });
    adminPanel.getWorkflowCohortConversion.mockImplementation(async () => {
      callOrder.push('getWorkflowCohortConversion');
      return { cohort: 'stub' };
    });

    const result = await controller.workflowFunnelCohortConversion(
      req,
      'month',
    );

    expect(adminPanel.assertOperator).toHaveBeenCalledWith('op-1');
    expect(callOrder).toEqual([
      'assertOperator',
      'getWorkflowCohortConversion',
    ]);
    expect(adminPanel.getWorkflowCohortConversion).toHaveBeenCalledWith(
      'month',
    );
    expect(result).toEqual({ cohort: 'stub' });
  });

  it('GET /admin/workflow-funnel/cohort-conversion: отказ assertOperator останавливает запрос — сервис данных не зовётся', async () => {
    const { controller, adminPanel, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new ForbiddenException());

    await expect(
      controller.workflowFunnelCohortConversion(req, 'month'),
    ).rejects.toThrow(ForbiddenException);
    expect(adminPanel.getWorkflowCohortConversion).not.toHaveBeenCalled();
  });
});

describe('AdminPanelController — GET /admin/sessions (доп. запрос владельца продукта: сортировки и фильтры по колонкам)', () => {
  it('требует assertOperator до обращения к данным', async () => {
    const { controller, adminPanel, req } = build();
    const callOrder: string[] = [];
    adminPanel.assertOperator.mockImplementation(async () => {
      callOrder.push('assertOperator');
    });
    adminPanel.listSessions.mockImplementation(async () => {
      callOrder.push('listSessions');
      return { items: [], total: 0, page: 1, pageSize: 20 };
    });

    await controller.listSessions(req);

    expect(callOrder).toEqual(['assertOperator', 'listSessions']);
  });

  it('валидные фильтры и сортировка передаются как есть', async () => {
    const { controller, adminPanel, req } = build();
    await controller.listSessions(
      req,
      'error',
      'standard',
      'dub',
      'PREMIUM',
      '2026-09-01',
      '2026-09-10',
      ' anna ',
      'plan',
      'asc',
      '2',
      '50',
    );
    expect(adminPanel.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        quality: 'standard',
        voiceMode: 'dub',
        plan: 'PREMIUM',
        search: 'anna',
        sortBy: 'plan',
        sortDir: 'asc',
        page: 2,
        pageSize: 50,
      }),
    );
    const call = adminPanel.listSessions.mock.calls[0][0];
    expect(call.createdFrom).toBeInstanceOf(Date);
    expect(call.createdTo).toBeInstanceOf(Date);
  });

  it('мусорные voiceMode/plan/sortBy/sortDir тихо отбрасываются — не 400', async () => {
    const { controller, adminPanel, req } = build();
    await controller.listSessions(
      req,
      undefined,
      undefined,
      'not-a-mode',
      'GOLD',
      undefined,
      undefined,
      undefined,
      'unknown-column',
      'sideways',
    );
    expect(adminPanel.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceMode: undefined,
        plan: undefined,
        sortBy: 'createdAt',
        sortDir: 'desc',
      }),
    );
  });

  it('невалидная дата отбрасывается, а не падает', async () => {
    const { controller, adminPanel, req } = build();
    await controller.listSessions(
      req,
      undefined,
      undefined,
      undefined,
      undefined,
      'не дата',
    );
    expect(adminPanel.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ createdFrom: undefined }),
    );
  });

  it('page/pageSize сохраняют прежние границы (минимум 1, максимум 100)', async () => {
    const { controller, adminPanel, req } = build();
    await controller.listSessions(
      req,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '0',
      '9999',
    );
    expect(adminPanel.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 100 }),
    );
  });
});

describe('AdminPanelController — /admin/settings/music-catalog', () => {
  it('GET: оператор проверяется до обращения к настройке', async () => {
    const { controller, adminPanel, musicCatalog, req } = build();
    const order: string[] = [];
    adminPanel.assertOperator.mockImplementation(async () => {
      order.push('assertOperator');
    });
    musicCatalog.get.mockImplementation(async () => {
      order.push('get');
      return { raw: '', themes: [] };
    });
    await controller.getMusicCatalog(req);
    expect(order).toEqual(['assertOperator', 'get']);
  });

  it('PATCH: оператор проверяется до записи, и записывается ОН', async () => {
    // `updatedBy` — админский аудит: кто менял каталог.
    const { controller, adminPanel, musicCatalog, req } = build();
    const order: string[] = [];
    adminPanel.assertOperator.mockImplementation(async () => {
      order.push('assertOperator');
    });
    musicCatalog.save.mockImplementation(async () => {
      order.push('save');
      return { raw: '[]', themes: [] };
    });
    await controller.setMusicCatalog(req, { raw: '[]' });
    expect(order).toEqual(['assertOperator', 'save']);
    expect(musicCatalog.save).toHaveBeenCalledWith('[]', 'op-1');
  });

  it('не оператор — до настройки дело не доходит', async () => {
    const { controller, adminPanel, musicCatalog, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));
    await expect(
      controller.setMusicCatalog(req, { raw: '[]' }),
    ).rejects.toThrow();
    expect(musicCatalog.save).not.toHaveBeenCalled();
  });
});

describe('AdminPanelController — /admin/settings/audio-separation (этап E)', () => {
  it('GET: оператор проверяется до обращения к настройке', async () => {
    const { controller, adminPanel, audioSeparation, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));

    await expect(controller.getAudioSeparation(req)).rejects.toThrow(
      'не оператор',
    );
    expect(audioSeparation.view).not.toHaveBeenCalled();
  });

  it('PATCH: записывается выбранное состояние и ИМЕННО оператор', async () => {
    const { controller, audioSeparation, req } = build();

    await controller.setAudioSeparation(req, { state: 'on' });

    expect(audioSeparation.set).toHaveBeenCalledWith('on', 'op-1');
    // Ответ — свежая витрина, а не эхо запроса: оператор должен
    // увидеть, что получилось, а не что он попросил.
    expect(audioSeparation.view).toHaveBeenCalled();
  });

  it('PATCH: оператор проверяется до записи', async () => {
    const { controller, adminPanel, audioSeparation, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));

    await expect(
      controller.setAudioSeparation(req, { state: 'off' }),
    ).rejects.toThrow('не оператор');
    expect(audioSeparation.set).not.toHaveBeenCalled();
  });
});

describe('AdminPanelController — /admin/settings/tutorial-voice (этап B)', () => {
  // Витрина обязательна, а не желательна: третий уровень отката §9 ТЗ
  // — «выключить озвучку без деплоя», и без экрана он неисполним.
  // Найдено аудитом этапа B: настройка была, включить её было нечем.
  it('GET: оператор проверяется до обращения к настройке', async () => {
    const { controller, adminPanel, tutorialVoice, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));

    await expect(controller.getTutorialVoice(req)).rejects.toThrow(
      'не оператор',
    );
    expect(tutorialVoice.view).not.toHaveBeenCalled();
  });

  it('PATCH: включение с голосом доходит до настройки вместе с оператором', async () => {
    const { controller, tutorialVoice, req } = build();

    await controller.setTutorialVoice(req, {
      enabled: true,
      voiceId: 'rachel-42',
      requireNarrationReview: false,
      captions: true,
      motion: 'none',
      pointer: false,
    });

    expect(tutorialVoice.set).toHaveBeenCalledWith(
      {
        enabled: true,
        voiceId: 'rachel-42',
        requireNarrationReview: false,
        captions: true,
        motion: 'none',
        pointer: false,
      },
      'op-1',
    );
  });

  it('PATCH: голос не указан — это «по умолчанию», а не пустая строка', async () => {
    // Пустая строка ушла бы провайдеру как id голоса.
    const { controller, tutorialVoice, req } = build();

    await controller.setTutorialVoice(req, {
      enabled: true,
      requireNarrationReview: false,
      captions: true,
      motion: 'none',
      pointer: false,
    });

    expect(tutorialVoice.set).toHaveBeenCalledWith(
      {
        enabled: true,
        voiceId: null,
        requireNarrationReview: false,
        captions: true,
        motion: 'none',
        pointer: false,
      },
      'op-1',
    );
  });

  it('PATCH: требование вычитки доезжает до сервиса', async () => {
    // Выключатель, который не доезжает, — это выключатель, который
    // ничего не выключает. Ровно та находка, что была у самой
    // озвучки на этапе B: настройка есть, включить нечем.
    const { controller, tutorialVoice, req } = build();

    await controller.setTutorialVoice(req, {
      enabled: true,
      requireNarrationReview: true,
      captions: true,
      motion: 'none',
      pointer: false,
    });

    expect(tutorialVoice.set).toHaveBeenCalledWith(
      expect.objectContaining({ requireNarrationReview: true }),
      'op-1',
    );
  });

  it('PATCH: режим движения доезжает до сервиса (этап G)', async () => {
    // Та же находка, что у вычитки: выключатель, который не
    // доезжает, ничего не выключает — а уровень отката «4-бис»
    // обещает выключить движение без деплоя.
    const { controller, tutorialVoice, req } = build();

    await controller.setTutorialVoice(req, {
      enabled: false,
      requireNarrationReview: false,
      captions: true,
      motion: 'fade+zoom',
      pointer: false,
    });

    expect(tutorialVoice.set).toHaveBeenCalledWith(
      expect.objectContaining({ motion: 'fade+zoom' }),
      'op-1',
    );
  });

  it('PATCH: указатель клика доезжает до сервиса (этап H)', async () => {
    const { controller, tutorialVoice, req } = build();

    await controller.setTutorialVoice(req, {
      enabled: false,
      requireNarrationReview: false,
      captions: true,
      motion: 'none',
      pointer: true,
    });

    expect(tutorialVoice.set).toHaveBeenCalledWith(
      expect.objectContaining({ pointer: true }),
      'op-1',
    );
  });

  it('PATCH: оператор проверяется до записи', async () => {
    const { controller, adminPanel, tutorialVoice, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));

    await expect(
      controller.setTutorialVoice(req, {
        enabled: false,
        requireNarrationReview: false,
        captions: true,
        motion: 'none',
        pointer: false,
      }),
    ).rejects.toThrow('не оператор');
    expect(tutorialVoice.set).not.toHaveBeenCalled();
  });
});

describe('AdminPanelController — /admin/settings/tutorial-locales (этап C)', () => {
  it('GET: оператор проверяется до обращения к настройке', async () => {
    const { controller, adminPanel, tutorialLocales, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));

    await expect(controller.getTutorialLocales(req)).rejects.toThrow(
      'не оператор',
    );
    expect(tutorialLocales.get).not.toHaveBeenCalled();
  });

  it('PATCH: сырой ввод уходит в настройку вместе с оператором', async () => {
    // Разбор живёт в `tutorial-locales.ts`, а не в DTO: оператор
    // пишет и `ru, en`, и JSON-массив.
    const { controller, tutorialLocales, req } = build();

    await controller.setTutorialLocales(req, { raw: 'ru, en' });

    expect(tutorialLocales.set).toHaveBeenCalledWith('ru, en', 'op-1');
  });

  it('PATCH: оператор проверяется до записи', async () => {
    const { controller, adminPanel, tutorialLocales, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));

    await expect(
      controller.setTutorialLocales(req, { raw: '["ru"]' }),
    ).rejects.toThrow('не оператор');
    expect(tutorialLocales.set).not.toHaveBeenCalled();
  });
});

describe('AdminPanelController — /admin/settings/speech-recognition-provider (Soniox)', () => {
  it('GET: оператор проверяется до обращения к настройке', async () => {
    const { controller, adminPanel, speechRecognition, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));
    await expect(controller.getSpeechRecognitionProvider(req)).rejects.toThrow(
      'не оператор',
    );
    expect(speechRecognition.get).not.toHaveBeenCalled();
  });

  it('PATCH: выбор уходит в настройку вместе с оператором', async () => {
    const { controller, speechRecognition, req } = build();
    await controller.setSpeechRecognitionProvider(req, { provider: 'soniox' });
    expect(speechRecognition.set).toHaveBeenCalledWith('soniox', 'op-1');
  });

  it('PATCH: оператор проверяется до записи', async () => {
    const { controller, adminPanel, speechRecognition, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));
    await expect(
      controller.setSpeechRecognitionProvider(req, { provider: 'soniox' }),
    ).rejects.toThrow('не оператор');
    expect(speechRecognition.set).not.toHaveBeenCalled();
  });
});

describe('AdminPanelController — /admin/settings/voice-assistant (этап K3)', () => {
  it('GET: оператор проверяется до обращения к настройке', async () => {
    const { controller, adminPanel, voiceAssistant, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));
    await expect(controller.getVoiceAssistant(req)).rejects.toThrow(
      'не оператор',
    );
    expect(voiceAssistant.view).not.toHaveBeenCalled();
  });

  it('PATCH: потолки и голос уходят в настройку вместе с оператором', async () => {
    const { controller, voiceAssistant, req } = build();
    await controller.setVoiceAssistant(req, {
      caps: { LITE: 0.75 },
      voice: { provider: 'soniox', voiceId: 'Maya' },
    });
    expect(voiceAssistant.set).toHaveBeenCalledWith(
      { caps: { LITE: 0.75 }, voice: { provider: 'soniox', voiceId: 'Maya' } },
      'op-1',
    );
  });

  it('PATCH: null у голоса — «вернуть умолчание» доезжает как есть', async () => {
    const { controller, voiceAssistant, req } = build();
    await controller.setVoiceAssistant(req, { voice: null });
    expect(voiceAssistant.set).toHaveBeenCalledWith({ voice: null }, 'op-1');
  });

  it('PATCH: оператор проверяется до записи', async () => {
    const { controller, adminPanel, voiceAssistant, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));
    await expect(
      controller.setVoiceAssistant(req, { caps: { LITE: 1 } }),
    ).rejects.toThrow('не оператор');
    expect(voiceAssistant.set).not.toHaveBeenCalled();
  });
});

describe('AdminPanelController — GET /admin/balances', () => {
  it('оператор проверяется до обращения к остаткам', async () => {
    const { controller, adminPanel, balances, req } = build();
    const order: string[] = [];
    adminPanel.assertOperator.mockImplementation(async () => {
      order.push('assertOperator');
    });
    balances.list.mockImplementation(async () => {
      order.push('list');
      return [];
    });
    await controller.providerBalances(req);
    expect(order).toEqual(['assertOperator', 'list']);
  });

  it('refresh=1 обходит кеш, остальное — нет', async () => {
    // Кеш здесь не про нашу скорость, а про чужое ограничение частоты:
    // экран, спрашивающий на каждый рендер, сам доводит до 429.
    const { controller, balances, req } = build();
    await controller.providerBalances(req, '1');
    expect(balances.list).toHaveBeenCalledWith(true);
    await controller.providerBalances(req);
    expect(balances.list).toHaveBeenLastCalledWith(false);
    await controller.providerBalances(req, 'yes');
    expect(balances.list).toHaveBeenLastCalledWith(false);
  });
});

describe('AdminPanelController — приглашения (этап 135)', () => {
  it('GET /admin/referrals: сперва assertOperator, потом данные', async () => {
    const { controller, adminPanel, referrals, req } = build();
    const order: string[] = [];
    adminPanel.assertOperator.mockImplementation(async () => {
      order.push('assert');
    });
    referrals.overview.mockImplementation(async () => {
      order.push('data');
      return { window: 'week' };
    });
    await controller.referralsOverview(req, 'week');
    expect(order).toEqual(['assert', 'data']);
  });

  it('мусорное окно не 400, а умолчание — как у воронки', async () => {
    const { controller, referrals, req } = build();
    await controller.referralsOverview(req, 'вчера');
    expect(referrals.overview).toHaveBeenCalledWith('week');
  });

  it('часового окна у приглашений нет', async () => {
    const { controller, referrals, req } = build();
    await controller.referralsOverview(req, 'hour');
    expect(referrals.overview).toHaveBeenCalledWith('week');
  });

  it('снятие приглашения доносит причину до сервиса', async () => {
    const { controller, referrals, req } = build();
    await controller.revokeReferral(req, 'r1', { reason: 'пачка за 4 минуты' });
    expect(referrals.revokeReferral).toHaveBeenCalledWith(
      'r1',
      'пачка за 4 минуты',
    );
  });

  it('отзыв разблокировки: причина уходит, карточка возвращается', async () => {
    const { controller, liteUnlock, users, req } = build();
    const result = await controller.revokeUserLite(req, 'u1', {
      reason: 'накрутка',
    });
    expect(liteUnlock.revoke).toHaveBeenCalledWith('u1', 'накрутка');
    expect(users.get).toHaveBeenCalledWith('u1');
    expect(result).toEqual({ id: 'u1' });
  });

  it('возврат разблокировки — отдельное действие оператора', async () => {
    // Автоматика её не вернёт (иначе отзыв отменялся бы первым же
    // следующим приглашением), поэтому маршрут обязан существовать —
    // без него приёмка «повторная разблокировка работает» невыполнима.
    const { controller, liteUnlock, req } = build();
    await controller.unlockUserLite(req, 'u1');
    expect(liteUnlock.grantByOperator).toHaveBeenCalledWith('u1');
  });

  it('все три маршрута закрыты проверкой оператора', async () => {
    const { controller, adminPanel, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));
    await expect(controller.referralsOverview(req)).rejects.toThrow();
    await expect(
      controller.revokeReferral(req, 'r1', { reason: 'x' }),
    ).rejects.toThrow();
    await expect(
      controller.revokeUserLite(req, 'u1', { reason: 'x' }),
    ).rejects.toThrow();
    await expect(controller.unlockUserLite(req, 'u1')).rejects.toThrow();
  });
});

describe('RevokeWithReasonDto — причина обязательна', () => {
  it('пустая строка не проходит: «почему пропал доступ» должно иметь ответ', async () => {
    const dto = plainToInstance(RevokeWithReasonDto, { reason: '' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
  });

  it('нормальная причина проходит', async () => {
    const dto = plainToInstance(RevokeWithReasonDto, { reason: 'накрутка' });
    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('длинный текст отсекается', async () => {
    const dto = plainToInstance(RevokeWithReasonDto, {
      reason: 'x'.repeat(301),
    });
    expect(await validate(dto)).toHaveLength(1);
  });
});

describe('AdminPanelController — очередь находок (этап 158)', () => {
  it('GET /admin/test-tickets: сперва assertOperator, потом данные', async () => {
    const { controller, adminPanel, testTickets, req } = build();
    const order: string[] = [];
    adminPanel.assertOperator.mockImplementation(async () => {
      order.push('assert');
    });
    testTickets.list.mockImplementation(async () => {
      order.push('list');
      return [];
    });
    await controller.testTickets(req, 'OPEN', undefined, 'p:s:tma:ios:uk');
    expect(order).toEqual(['assert', 'list']);
    expect(testTickets.list).toHaveBeenCalledWith({
      status: 'OPEN',
      userId: undefined,
      envKey: 'p:s:tma:ios:uk',
    });
  });

  it('прогресс — отдельный маршрут, и он тоже за гвардом', async () => {
    const { controller, adminPanel, testTickets, req } = build();
    await controller.testTicketsProgress(req);
    expect(adminPanel.assertOperator).toHaveBeenCalledWith('op-1');
    expect(testTickets.progress).toHaveBeenCalled();
  });

  it('смена статуса доносит до сервиса и статус, и причину, и оператора', async () => {
    const { controller, testTickets, req } = build();
    await controller.patchTestTicketStatus(req, 't1', {
      status: 'REJECTED',
      note: 'не воспроизводится',
    });
    expect(testTickets.setStatus).toHaveBeenCalledWith(
      'op-1',
      't1',
      'REJECTED',
      'не воспроизводится',
    );
  });

  it('причина не пришла — до сервиса доезжает null, а не undefined', async () => {
    // Обязательность причины решает сервис: она зависит от статуса, и
    // условие такого вида декоратором выражается хуже, чем кодом.
    const { controller, testTickets, req } = build();
    await controller.patchTestTicketStatus(req, 't1', { status: 'FIXED' });
    expect(testTickets.setStatus).toHaveBeenCalledWith(
      'op-1',
      't1',
      'FIXED',
      null,
    );
  });

  it('ответ тестировщику уходит от имени оператора', async () => {
    const { controller, adminPanel, testTickets, req } = build();
    await controller.replyToTestTicket(req, 't1', {
      text: 'проверьте ещё раз',
    });
    expect(adminPanel.assertOperator).toHaveBeenCalledWith('op-1');
    expect(testTickets.reply).toHaveBeenCalledWith(
      'op-1',
      't1',
      'проверьте ещё раз',
    );
  });
});

describe('AdminPanelController — /admin/settings/persona-look-quota (этап F)', () => {
  it('GET: оператор проверяется до обращения к настройке', async () => {
    const { controller, adminPanel, personaLookQuota, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));
    await expect(controller.getPersonaLookQuota(req)).rejects.toThrow(
      'не оператор',
    );
    expect(personaLookQuota.view).not.toHaveBeenCalled();
  });

  it('PATCH: уходят только присланные тариф и период, с оператором', async () => {
    const { controller, personaLookQuota, req } = build();
    await controller.setPersonaLookQuota(req, {
      LITE: { day: 5 },
      PREMIUM: { day: undefined, month: 0 },
    });
    // Строго: «не присланный» период не должен доехать даже как undefined.
    expect(personaLookQuota.set.mock.calls[0][0]).toStrictEqual({
      LITE: { day: 5 },
      PREMIUM: { month: 0 },
    });
    expect(personaLookQuota.set.mock.calls[0][1]).toBe('op-1');
  });

  it('PATCH: оператор проверяется до записи', async () => {
    const { controller, adminPanel, personaLookQuota, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));
    await expect(
      controller.setPersonaLookQuota(req, { LITE: { day: 1 } }),
    ).rejects.toThrow('не оператор');
    expect(personaLookQuota.set).not.toHaveBeenCalled();
  });
});

describe('AdminPanelController — плашка пользователя (users/brief, users/:id/avatar)', () => {
  function response() {
    const res: any = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      body: undefined as unknown,
      ended: false,
    };
    res.status = jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    });
    res.setHeader = jest.fn((k: string, v: string) => {
      res.headers[k] = v;
    });
    res.send = jest.fn((b: unknown) => {
      res.body = b;
      res.ended = true;
    });
    res.end = jest.fn(() => {
      res.ended = true;
    });
    return res;
  }

  it('users/brief объявлен раньше users/:id — иначе «brief» стал бы id', () => {
    // Nest сопоставляет маршруты в порядке объявления методов класса.
    const names = Object.getOwnPropertyNames(AdminPanelController.prototype);
    expect(names.indexOf('userBriefs')).toBeGreaterThan(-1);
    expect(names.indexOf('userBriefs')).toBeLessThan(names.indexOf('getUser'));
  });

  it('users/brief: оператор проверяется, id разобраны (пустые и дубли выкинуты)', async () => {
    const { controller, adminPanel, users, req } = build();
    await controller.userBriefs(req, 'a, b,,a');
    expect(adminPanel.assertOperator).toHaveBeenCalledWith('op-1');
    expect(users.briefs).toHaveBeenCalledWith(['a', 'b']);
  });

  it('users/brief: повторённый ?ids= (массив) разбирается, а не 500', async () => {
    const { controller, users, req } = build();
    await controller.userBriefs(req, ['a', 'b']);
    expect(users.briefs).toHaveBeenCalledWith(['a', 'b']);
  });

  it('users/brief: не оператор — до данных не доходит', async () => {
    const { controller, adminPanel, users, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new ForbiddenException());
    await expect(controller.userBriefs(req, 'a')).rejects.toThrow(
      ForbiddenException,
    );
    expect(users.briefs).not.toHaveBeenCalled();
  });

  it('avatar: есть фото — байты, тип и приватный кеш на сутки', async () => {
    const { controller, avatars, req } = build();
    const bytes = Buffer.from([0xff, 0xd8]);
    avatars.avatar.mockResolvedValue({ bytes, type: 'image/jpeg' });
    const res = response();
    await controller.userAvatar(req, 'u1', res);
    expect(avatars.avatar).toHaveBeenCalledWith('u1');
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/jpeg');
    expect(res.headers['Cache-Control']).toBe('private, max-age=86400');
    expect(res.body).toBe(bytes);
  });

  it('avatar: фото нет — пустой 404 без исключения (не пишет в лог ошибок)', async () => {
    const { controller, req } = build();
    const res = response();
    await controller.userAvatar(req, 'u1', res);
    expect(res.statusCode).toBe(404);
    expect(res.ended).toBe(true);
    expect(res.send).not.toHaveBeenCalled();
  });

  it('avatar: не оператор — Telegram не спрашивается', async () => {
    const { controller, adminPanel, avatars, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new ForbiddenException());
    await expect(controller.userAvatar(req, 'u1', response())).rejects.toThrow(
      ForbiddenException,
    );
    expect(avatars.avatar).not.toHaveBeenCalled();
  });
});
