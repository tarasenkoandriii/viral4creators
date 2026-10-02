/**
 * Съёмка четырёх кадров лендинга одним вызовом.
 *
 * Проверяется ровно то знание, которое раньше жило таблицей в
 * документе и потому врало бы после первой правки сценария:
 * соответствие «какой по счёту кадр → какая карточка» и сброс
 * черновика между локалями.
 */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { TutorialFramesCaptureService } from './tutorial-frames-capture.service';
import {
  ClientSiteAccessService,
  SERVICE_CONSENT_LOCALE,
} from '../client-site-tutorial/site-access.service';
import { ACCOUNT_CONSENT_TEXT_VERSION } from '../client-site-tutorial/account-consent';

/**
 * Настоящий сервис режима (Э-С Ш1) поверх «базы» в памяти: фикстура — не
 * владелец подтверждённого хоста, кабинет сайтов отвечает режимом B.
 * Именно так съёмка выглядит на проде.
 */
function accessInMemory(mode: 'A' | 'B' = 'B', policy?: string) {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ telegramId: '777000' }),
    },
    siteTutorialAccountConsent: {
      findUnique: jest
        .fn()
        .mockImplementation(
          ({ where }: { where: Record<string, Record<string, string>> }) => {
            const k = where.userId_registrableDomain_textVersion;
            const hit = rows.find(
              (r) =>
                r.userId === k.userId &&
                r.registrableDomain === k.registrableDomain &&
                r.textVersion === k.textVersion,
            );
            return Promise.resolve(hit ? { id: 'c1' } : null);
          },
        ),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          rows.push(data);
          return Promise.resolve({ id: 'c2', ...data });
        }),
    },
  };
  const sites = {
    configured: () => true,
    hostStatus: jest.fn().mockImplementation((_tg: string, url: string) =>
      Promise.resolve({
        mode,
        host: new URL(url).hostname,
        registrableDomain: null,
        hostId: null,
        status: mode === 'A' ? 'verified' : 'none',
        expiresAt: null,
        optedOut: false,
        reason: mode === 'A' ? null : 'no_account',
      }),
    ),
  };
  const access = new ClientSiteAccessService(prisma as never, sites as never);
  access.env = policy ? { SITE_TUTORIAL_ACCOUNT_CONSENT: policy } : {};
  return { access, rows, prisma };
}

function build(o: { mode?: 'A' | 'B'; policy?: string } = {}) {
  const runner = {
    findFixtureUser: jest.fn().mockResolvedValue({ id: 'usr_fixture' }),
    resolveFixtureContext: jest
      .fn()
      .mockResolvedValue({ clientSiteProjectId: 'proj_cs' }),
    run: jest.fn(),
  };
  const tutorial = { remove: jest.fn().mockResolvedValue(undefined) };
  const mem = accessInMemory(o.mode, o.policy);
  const service = new TutorialFramesCaptureService(
    runner as never,
    tutorial as never,
    mem.access,
  );
  service.env = {};
  return { service, runner, tutorial, ...mem };
}

/** Прогон мастера отдаёт шесть кадров (пять шагов + итоговый),
 *  прогон ролика — один. */
function happyRuns(runner: { run: jest.Mock }) {
  runner.run.mockImplementation((opts: { routeKeys: string[] }) =>
    opts.routeKeys[0] === 'site-tutorial'
      ? {
          total: 1,
          outcomes: [
            {
              routeKey: 'site-tutorial',
              changed: false,
              stepsDone: 5,
              shots: [
                { stepIndex: 0, url: 's1' },
                { stepIndex: 1, url: 's2' },
                { stepIndex: 2, url: 's3' },
                { stepIndex: 3, url: 's4' },
                { stepIndex: 4, url: 's5' },
              ],
              blobUrl: 'final',
            },
          ],
        }
      : {
          total: 1,
          outcomes: [
            { routeKey: 'postprod-video', changed: false, blobUrl: 'video' },
          ],
        },
  );
}

describe('TutorialFramesCaptureService', () => {
  it('кадры раскладываются по карточкам; проверочный и «грузится» никуда не идут', async () => {
    // Из шести кадров на страницу идут три: первый снят после
    // проверки «экран дошёл до стадии url», третий — сразу после
    // клика, когда страница ещё грузится. Ни один не иллюстрирует
    // подпись. Это и есть причина, по которой таблица нужна в коде, а
    // не в документе.
    const { service, runner } = build();
    happyRuns(runner);

    const r = await service.capture({ locales: ['ru'] });

    expect(r.locales[0].cards).toEqual({
      1: 's2',
      2: 's4',
      3: 's5',
      4: 'video',
    });
    expect(r.locales[0].problems).toEqual([]);
  });

  it('черновик сбрасывается ПЕРЕД каждой локалью', async () => {
    // Без сброса вторая локаль снимет вместо пустой формы стадию
    // `page`: карточка 1 выйдет не той, и молча.
    const { service, runner, tutorial } = build();
    happyRuns(runner);

    await service.capture({ locales: ['ru', 'en'] });

    expect(tutorial.remove).toHaveBeenCalledTimes(2);
    expect(tutorial.remove).toHaveBeenCalledWith('usr_fixture', 'proj_cs');
  });

  it('черновик не сбросился — прогон не начинается вовсе', async () => {
    // «Почти правильный» кадр хуже отсутствующего: его пропустят
    // глазами.
    const { service, runner, tutorial } = build();
    happyRuns(runner);
    tutorial.remove.mockRejectedValue(new Error('база лежит'));

    const r = await service.capture({ locales: ['ru'] });

    expect(runner.run).not.toHaveBeenCalled();
    expect(r.locales[0].problems[0]).toMatch(/черновик не сброшен/);
    expect(r.locales[0].cards).toEqual({});
  });

  it('локали снимаются каждая со своей — темой и плотностью не ошибаемся', async () => {
    const { service, runner } = build();
    happyRuns(runner);

    await service.capture({ locales: ['ru', 'en'] });

    const wizardRuns = runner.run.mock.calls
      .map(([o]: [{ routeKeys: string[]; locale: string }]) => o)
      .filter((o) => o.routeKeys[0] === 'site-tutorial');
    expect(wizardRuns.map((o) => o.locale)).toEqual(['ru', 'en']);
    for (const o of runner.run.mock.calls.map(([x]: [never]) => x) as {
      unmasked: boolean;
      deviceScaleFactor: number;
      alerts: boolean;
    }[]) {
      expect(o.unmasked).toBe(true);
      expect(o.deviceScaleFactor).toBe(2);
      // Тревоги в служебный канал шлёт крон, у которого нет человека.
      // Здесь человек смотрит на ответ.
      expect(o.alerts).toBe(false);
    }
  });

  it('первый шаг — проверка, что экран рабочий, а не сразу ввод', async () => {
    // §4 требует «экран в рабочем состоянии, а не в ошибке, спиннере
    // или пустоте». Первая редакция обещала эту проверку в
    // доккомментарии, но в шагах её не было вовсе — аудит 27.09.2026
    // на собственной работе.
    const { service, runner } = build();
    happyRuns(runner);

    await service.capture({ locales: ['ru'] });

    const steps = runner.run.mock.calls
      .map(([o]: [{ routeKeys: string[]; steps?: { kind: string }[] }]) => o)
      .find((o) => o.routeKeys[0] === 'site-tutorial')?.steps;
    expect(steps?.[0].kind).toBe('assertVisible');
  });

  it('готовый ролик снимается БЕЗ шагов — это состояние из базы', async () => {
    const { service, runner } = build();
    happyRuns(runner);

    await service.capture({ locales: ['ru'] });

    const videoRun = runner.run.mock.calls
      .map(([o]: [{ routeKeys: string[]; steps?: unknown }]) => o)
      .find((o) => o.routeKeys[0] === 'postprod-video');
    expect(videoRun?.steps).toBeUndefined();
  });

  it('сценарий оборвался — годные кадры отданы, недостающие названы', async () => {
    const { service, runner } = build();
    runner.run.mockImplementation((opts: { routeKeys: string[] }) =>
      opts.routeKeys[0] === 'site-tutorial'
        ? {
            total: 1,
            outcomes: [
              {
                routeKey: 'site-tutorial',
                changed: false,
                error: 'кнопка не нашлась',
                stepsDone: 2,
                shots: [
                  { stepIndex: 0, url: 's1' },
                  { stepIndex: 1, url: 's2' },
                ],
              },
            ],
          }
        : {
            total: 1,
            outcomes: [
              { routeKey: 'postprod-video', changed: false, blobUrl: 'video' },
            ],
          },
    );

    const r = await service.capture({ locales: ['ru'] });

    expect(r.locales[0].cards).toEqual({ 1: 's2', 4: 'video' });
    expect(r.locales[0].problems.join(' ')).toMatch(/кнопка не нашлась/);
    expect(r.locales[0].problems.join(' ')).toMatch(/не сняты карточки: 2, 3/);
  });

  it('кадр шага пропал — остальные карточки НЕ съезжают на соседний экран', async () => {
    // Правка аудита этапа A. Скриншот снимается best-effort: сбой
    // одного кадра глотается, чтобы не ронять прогон. Раньше кадр
    // брался по позиции в массиве, и пропажа первого кадра сдвигала
    // все следующие: карточка 1 получала экран второго шага,
    // карточка 2 — четвёртого. Внешне всё снято, а показано не то —
    // и заметить это можно было только глазами, на лендинге.
    const { service, runner } = build();
    runner.run.mockImplementation((opts: { routeKeys: string[] }) =>
      opts.routeKeys[0] === 'site-tutorial'
        ? {
            total: 1,
            outcomes: [
              {
                routeKey: 'site-tutorial',
                changed: false,
                stepsDone: 5,
                // Кадр шага 0 не снялся — его в списке просто нет.
                shots: [
                  { stepIndex: 1, url: 's2' },
                  { stepIndex: 2, url: 's3' },
                  { stepIndex: 3, url: 's4' },
                  { stepIndex: 4, url: 's5' },
                ],
                blobUrl: 'final',
              },
            ],
          }
        : {
            total: 1,
            outcomes: [
              { routeKey: 'postprod-video', changed: false, blobUrl: 'video' },
            ],
          },
    );

    const r = await service.capture({ locales: ['ru'] });

    // Ровно то же, что при полном наборе: пропал кадр, который
    // карточкам и не нужен.
    expect(r.locales[0].cards).toEqual({
      1: 's2',
      2: 's4',
      3: 's5',
      4: 'video',
    });
  });

  it('фикстуры нет — пропуск целиком, ни одного прогона', async () => {
    const { service, runner } = build();
    runner.findFixtureUser.mockResolvedValue(null);

    const r = await service.capture({ locales: ['ru'] });

    expect(r.skipped).toMatch(/фикстурный вход/);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('у фикстуры нет проекта обучалки — пропуск с внятной причиной', async () => {
    const { service, runner } = build();
    runner.resolveFixtureContext.mockResolvedValue({});

    const r = await service.capture({ locales: ['ru'] });

    expect(r.skipped).toMatch(/сайт заказчика/);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('в поле мастера печатается НАШ адрес, а не чужой', async () => {
    // §9 ТЗ: чужой сайт в кадре показывать не вправе.
    const { service, runner } = build();
    happyRuns(runner);

    await service.capture({ locales: ['ru'] });

    const steps = runner.run.mock.calls
      .map(([o]: [{ routeKeys: string[]; steps?: { value?: string }[] }]) => o)
      .find((o) => o.routeKeys[0] === 'site-tutorial')?.steps;
    // Первый шаг — проверочный `assertVisible`, адрес печатает второй.
    expect(steps?.[1].value).toBe('https://viral4creators.app');
  });
  describe('Э-С Ш1, SITE_TUTORIAL_ACCOUNT_CONSENT=required: мастер в режиме B ждёт подтверждения прав (П-Т2)', () => {
    /**
     * Мастер как в браузере: после клика «Открыть» экран спрашивает режим
     * и, если нужна галочка, страницу НЕ открывает — `waitFor` кадра сайта
     * не дожидается ничего. Решение берётся у настоящего сервиса режима.
     */
    function wizardLikeBrowser(
      runner: { run: jest.Mock },
      access: ClientSiteAccessService,
    ) {
      runner.run.mockImplementation(
        async (opts: { routeKeys: string[]; steps?: { value?: string }[] }) => {
          if (opts.routeKeys[0] !== 'site-tutorial') {
            return {
              total: 1,
              outcomes: [
                {
                  routeKey: 'postprod-video',
                  changed: false,
                  blobUrl: 'video',
                },
              ],
            };
          }
          const view = await access.resolve(
            'usr_fixture',
            String(opts.steps?.[1]?.value),
          );
          const gated = view.consent.required && !view.consent.accepted;
          return {
            total: 1,
            outcomes: [
              gated
                ? {
                    routeKey: 'site-tutorial',
                    changed: false,
                    error:
                      'waitFor [data-qa-mask="client-site-frame"]: таймаут',
                    stepsDone: 3,
                    shots: [
                      { stepIndex: 0, url: 's1' },
                      { stepIndex: 1, url: 's2' },
                      { stepIndex: 2, url: 's3' },
                    ],
                  }
                : {
                    routeKey: 'site-tutorial',
                    changed: false,
                    stepsDone: 5,
                    shots: [0, 1, 2, 3, 4].map((i) => ({
                      stepIndex: i,
                      url: `s${i + 1}`,
                    })),
                  },
            ],
          };
        },
      );
    }

    it('фикстура без кабинета сайтов: по нашему домену все четыре карточки сняты', async () => {
      const { service, runner, access, rows } = build({
        mode: 'B',
        policy: 'required',
      });
      wizardLikeBrowser(runner, access);

      const r = await service.capture({ locales: ['ru', 'en'] });

      for (const l of r.locales) {
        expect(l.cards).toEqual({ 1: 's2', 2: 's4', 3: 's5', 4: 'video' });
        expect(l.problems).toEqual([]);
      }
      // Одна служебная запись на домен, честно помеченная: текст человеку
      // не показывался, адреса нет.
      expect(rows).toEqual([
        {
          userId: 'usr_fixture',
          registrableDomain: 'viral4creators.app',
          textVersion: ACCOUNT_CONSENT_TEXT_VERSION,
          locale: SERVICE_CONSENT_LOCALE,
          ipHash: null,
        },
      ]);
    });

    it('поддомен стенда из LANDING_PUBLIC_URL — тоже наш', async () => {
      const { service, runner, access, rows } = build({
        mode: 'B',
        policy: 'required',
      });
      service.env = {
        LANDING_PUBLIC_URL: 'https://stage-landing.example.org/x',
      };
      wizardLikeBrowser(runner, access);

      const r = await service.capture({
        locales: ['ru'],
        siteUrl: 'https://cab.example.org',
      });

      expect(r.locales[0].problems).toEqual([]);
      expect(rows[0]).toMatchObject({ registrableDomain: 'example.org' });
    });

    it('чужой siteUrl: служебной галочки нет, мастер не запускается, причина названа', async () => {
      const { service, runner, access, rows, prisma } = build({
        mode: 'B',
        policy: 'required',
      });
      wizardLikeBrowser(runner, access);

      const r = await service.capture({
        locales: ['ru'],
        siteUrl: 'https://bank.example.com',
      });

      expect(prisma.siteTutorialAccountConsent.create).not.toHaveBeenCalled();
      expect(rows).toEqual([]);
      const wizardRuns = runner.run.mock.calls.filter(
        ([o]: [{ routeKeys: string[] }]) => o.routeKeys[0] === 'site-tutorial',
      );
      expect(wizardRuns).toHaveLength(0);
      expect(r.locales[0].problems.join(' ')).toMatch(
        /example\.com не наш.*мастер не снимался/,
      );
      // Готовый ролик от сайта не зависит — снят.
      expect(r.locales[0].cards).toEqual({ 4: 'video' });
    });

    it('режим A (фикстура владеет подтверждённым хостом): служебная запись не нужна', async () => {
      const { service, runner, access, prisma } = build({
        mode: 'A',
        policy: 'required',
      });
      wizardLikeBrowser(runner, access);

      const r = await service.capture({ locales: ['ru'] });

      expect(r.locales[0].problems).toEqual([]);
      expect(prisma.siteTutorialAccountConsent.create).not.toHaveBeenCalled();
    });
  });

  describe('journal/off (по умолчанию journal): галочки нет — служебная запись не нужна', () => {
    it.each([[undefined], ['journal'], ['off']])(
      'политика %s: по нашему домену и по чужому мастер снимается, служебной строки нет',
      async (policy) => {
        for (const siteUrl of [undefined, 'https://bank.example.com']) {
          const { service, runner, access, prisma } = build({
            mode: 'B',
            policy,
          });
          runner.run.mockImplementation(
            async (opts: {
              routeKeys: string[];
              steps?: { value?: string }[];
            }) => {
              if (opts.routeKeys[0] !== 'site-tutorial') {
                return {
                  total: 1,
                  outcomes: [{ routeKey: 'postprod-video', blobUrl: 'video' }],
                };
              }
              const view = await access.resolve(
                'usr_fixture',
                String(opts.steps?.[1]?.value),
              );
              expect(view.consent.required).toBe(false);
              return {
                total: 1,
                outcomes: [
                  {
                    routeKey: 'site-tutorial',
                    stepsDone: 5,
                    shots: [0, 1, 2, 3, 4].map((i) => ({
                      stepIndex: i,
                      url: `s${i + 1}`,
                    })),
                  },
                ],
              };
            },
          );

          const r = await service.capture({ locales: ['ru'], siteUrl });

          expect(r.locales[0].problems).toEqual([]);
          expect(r.locales[0].cards).toEqual({
            1: 's2',
            2: 's4',
            3: 's5',
            4: 'video',
          });
          expect(
            prisma.siteTutorialAccountConsent.create,
          ).not.toHaveBeenCalled();
        }
      },
    );
  });
});
