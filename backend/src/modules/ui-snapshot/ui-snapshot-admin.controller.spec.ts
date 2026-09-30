/**
 * Проверка разбора тела запроса у POST /admin/ui-snapshot/run.
 *
 * Контроллер появился в этапе H и до сих пор жил без теста: его
 * проверку видели только на проде (`{"theme":"purple"}` → 400). Этап I
 * добавил ему ещё две ветки отказа, и дальше на глаз нельзя: ветка
 * «плотность 2 без unmasked» защищает базу сравнения крона, а такую
 * защиту надо уметь уронить нарочно.
 */
import { BadRequestException } from '@nestjs/common';
import { UiSnapshotAdminController } from './ui-snapshot-admin.controller';

function build() {
  const adminPanel = { assertOperator: jest.fn().mockResolvedValue(undefined) };
  const runner = { run: jest.fn().mockResolvedValue({ total: 0 }) };
  const frames = { capture: jest.fn().mockResolvedValue({ locales: [] }) };
  const greetingFrames = {
    capture: jest.fn().mockResolvedValue({ locales: [] }),
    fixtureVideo: jest.fn().mockResolvedValue({ stage: 'complete' }),
  };
  const controller = new UiSnapshotAdminController(
    adminPanel as never,
    runner as never,
    frames as never,
    greetingFrames as never,
  );
  const req = { userId: 'usr_admin' } as never;
  return { controller, runner, frames, greetingFrames, adminPanel, req };
}

describe('UiSnapshotAdminController — разбор тела', () => {
  it('без параметров — прогон с умолчаниями и всегда без тревог', async () => {
    const { controller, runner, req } = build();

    await controller.run(req, {});

    expect(runner.run).toHaveBeenCalledWith({
      locale: undefined,
      theme: undefined,
      routeKeys: undefined,
      unmasked: false,
      deviceScaleFactor: undefined,
      steps: undefined,
      scrollTo: undefined,
      alerts: false,
    });
  });

  it('локаль не из списка продукта — 400, прогон не запускается', async () => {
    const { controller, runner, req } = build();

    await expect(controller.run(req, { locale: 'rи' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('тема не light/dark — 400', async () => {
    const { controller, runner, req } = build();

    await expect(
      controller.run(req, { theme: 'purple' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('пустой routeKeys — 400', async () => {
    const { controller, runner, req } = build();

    await expect(controller.run(req, { routeKeys: [] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('плотность 2 вместе с unmasked — доезжает до сервиса', async () => {
    const { controller, runner, req } = build();

    await controller.run(req, {
      routeKeys: ['site-tutorial'],
      locale: 'de',
      theme: 'dark',
      unmasked: true,
      deviceScaleFactor: 2,
    });

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({ deviceScaleFactor: 2, unmasked: true }),
    );
  });

  it('плотность 2 без unmasked — 400 с объяснением, а не 500 из сервиса', async () => {
    const { controller, runner, req } = build();

    await expect(controller.run(req, { deviceScaleFactor: 2 })).rejects.toThrow(
      /unmasked/,
    );
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('плотность 3 — 400: промежуточные и большие значения не нужны никому', async () => {
    const { controller, runner, req } = build();

    await expect(
      controller.run(req, { deviceScaleFactor: 3, unmasked: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(runner.run).not.toHaveBeenCalled();
  });

  // Шаги — этап I, второй заход (27.09.2026): две карточки лендинга из
  // четырёх это мгновенные состояния браузера, и снять их можно только
  // действием на уже открытом экране, а не открытием маршрута.
  describe('steps', () => {
    const OK_STEPS = [
      {
        kind: 'fill',
        selector: '#site-url',
        value: 'https://viral4creators.app',
      },
      { kind: 'click', selector: '[data-qa="client-site-explore"]' },
    ];

    it('шаги с unmasked и одним маршрутом — доезжают до сервиса', async () => {
      const { controller, runner, req } = build();

      await controller.run(req, {
        routeKeys: ['site-tutorial'],
        unmasked: true,
        deviceScaleFactor: 2,
        steps: OK_STEPS,
      });

      expect(runner.run).toHaveBeenCalledWith(
        expect.objectContaining({ steps: OK_STEPS }),
      );
    });

    it('шаги без unmasked — 400: сравниваемый прогон обязан быть наблюдателем', async () => {
      // Запрет строже, чем у плотности: шаги МЕНЯЮТ состояние продукта
      // — создают черновик, отправляют формы. Прогон, который пишет
      // отпечаток в базу, действовать не вправе.
      const { controller, runner, req } = build();

      await expect(
        controller.run(req, { routeKeys: ['site-tutorial'], steps: OK_STEPS }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('шаги без ровно одного маршрута — 400', async () => {
      // Шаги написаны под конкретный экран: на чужом селекторы либо не
      // найдутся, либо найдутся не те.
      const { controller, runner, req } = build();

      await expect(
        controller.run(req, { unmasked: true, steps: OK_STEPS }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        controller.run(req, {
          unmasked: true,
          routeKeys: ['site-tutorial', 'generate'],
          steps: OK_STEPS,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('goto среди шагов — 400: маршрут задаётся routeKeys', async () => {
      const { controller, runner, req } = build();

      await expect(
        controller.run(req, {
          routeKeys: ['site-tutorial'],
          unmasked: true,
          // Селектор тут есть намеренно: без него шаг отвергла бы
          // соседняя проверка, и тест проходил бы, не проверяя
          // словарь. Эту ловушку поймала мутация.
          steps: [{ kind: 'goto', route: 'generate', selector: '#site-url' }],
        }),
      ).rejects.toThrow(/kind должен быть одним из/);
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('triggerPaidOperation среди шагов — 400: здесь он не значит ничего', async () => {
      // В сценарии обучалки это декларативный маркер для оценки
      // стоимости. Пропустить его сюда значит дать оператору шаг,
      // который молча ничего не делает.
      const { controller, runner, req } = build();

      await expect(
        controller.run(req, {
          routeKeys: ['site-tutorial'],
          unmasked: true,
          steps: [
            {
              kind: 'triggerPaidOperation',
              operation: 'video',
              model: 'veo',
              expectedUnits: {},
              note: 'x',
              selector: '#site-url',
            },
          ],
        }),
      ).rejects.toThrow(/kind должен быть одним из/);
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('шаг без селектора — 400 с номером шага', async () => {
      const { controller, req } = build();

      await expect(
        controller.run(req, {
          routeKeys: ['site-tutorial'],
          unmasked: true,
          steps: [{ kind: 'fill', value: 'x' }],
        }),
      ).rejects.toThrow(/шаг 1/);
    });

    it('пустой массив шагов — 400, а не «шагов нет»', async () => {
      // Пустой массив прислали намеренно, значит имели в виду шаги;
      // молча превратить это в обычный прогон — скрыть опечатку.
      const { controller, req } = build();

      await expect(
        controller.run(req, {
          routeKeys: ['site-tutorial'],
          unmasked: true,
          steps: [],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('не оператор — до разбора тела дело не доходит', async () => {
    const { controller, runner, adminPanel, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));

    await expect(controller.run(req, { theme: 'purple' })).rejects.toThrow(
      'не оператор',
    );
    expect(runner.run).not.toHaveBeenCalled();
  });
});

/**
 * Этап I ТЗ Greeting 2.0 (§5.3): прокрутка к секции у ручного прогона и
 * две кнопки кадров поздравлений. Прокрутка меняет отпечаток кадра,
 * значит у неё те же запреты, что у шагов, — и их надо уметь уронить.
 */
describe('UiSnapshotAdminController — кадры поздравлений', () => {
  it('scrollTo с unmasked и одним маршрутом — доезжает до сервиса', async () => {
    const { controller, runner, req } = build();

    await controller.run(req, {
      routeKeys: ['greeting-video-ready'],
      unmasked: true,
      scrollTo: ' [data-qa="greeting-script-card"] ',
    });

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        scrollTo: '[data-qa="greeting-script-card"]',
        unmasked: true,
      }),
    );
  });

  it('scrollTo без unmasked — 400: прокрученный кадр подменил бы отпечаток крона', async () => {
    const { controller, runner, req } = build();

    await expect(
      controller.run(req, {
        routeKeys: ['greeting-video-ready'],
        scrollTo: '[data-qa="greeting-script-card"]',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('scrollTo без ровно одного маршрута — 400', async () => {
    const { controller, runner, req } = build();

    await expect(
      controller.run(req, {
        routeKeys: ['greeting-video', 'greeting-video-ready'],
        unmasked: true,
        scrollTo: '[data-qa="greeting-script-card"]',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.run(req, { unmasked: true, scrollTo: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('greeting-frames: локали и тема разбираются тем же разбором, что у обучалки', async () => {
    const { controller, greetingFrames, req } = build();

    await controller.greetingFramesCapture(req, {
      locales: ['ru', 'de'],
      theme: 'dark',
    });
    expect(greetingFrames.capture).toHaveBeenCalledWith({
      locales: ['ru', 'de'],
      theme: 'dark',
    });

    await controller.greetingFramesCapture(req, {});
    expect(greetingFrames.capture).toHaveBeenLastCalledWith({
      locales: ['ru'],
      theme: undefined,
    });

    await expect(
      controller.greetingFramesCapture(req, { locales: ['xx'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.greetingFramesCapture(req, { theme: 'purple' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(greetingFrames.capture).toHaveBeenCalledTimes(2);
  });

  it('fixture-video: переснять готовый ролик — только строгим true', async () => {
    const { controller, greetingFrames, req } = build();

    await controller.greetingFixtureVideo(req, {});
    await controller.greetingFixtureVideo(req, { rerender: 'yes' });
    await controller.greetingFixtureVideo(req, { rerender: true });

    expect(greetingFrames.fixtureVideo.mock.calls).toEqual([
      [{ rerender: false }],
      [{ rerender: false }],
      [{ rerender: true }],
    ]);
  });

  it('обе кнопки — только оператору: платный рендер не запускается без проверки', async () => {
    const { controller, greetingFrames, adminPanel, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));

    await expect(controller.greetingFixtureVideo(req, {})).rejects.toThrow(
      'не оператор',
    );
    await expect(controller.greetingFramesCapture(req, {})).rejects.toThrow(
      'не оператор',
    );
    expect(greetingFrames.fixtureVideo).not.toHaveBeenCalled();
    expect(greetingFrames.capture).not.toHaveBeenCalled();
  });
});
