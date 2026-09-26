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
  const controller = new UiSnapshotAdminController(
    adminPanel as never,
    runner as never,
  );
  const req = { userId: 'usr_admin' } as never;
  return { controller, runner, adminPanel, req };
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

  it('не оператор — до разбора тела дело не доходит', async () => {
    const { controller, runner, adminPanel, req } = build();
    adminPanel.assertOperator.mockRejectedValue(new Error('не оператор'));

    await expect(controller.run(req, { theme: 'purple' })).rejects.toThrow(
      'не оператор',
    );
    expect(runner.run).not.toHaveBeenCalled();
  });
});
