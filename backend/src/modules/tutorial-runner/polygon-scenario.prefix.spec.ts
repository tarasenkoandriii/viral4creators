/**
 * Замок «только /qa/» — отдельно от таблицы: в настоящей таблице все пути
 * под `/qa/`, и проверить, что префикс действительно проверяется, на ней
 * нельзя. Здесь таблица подменена путями мимо `/qa/`.
 */
jest.mock('./polygon-catalog', () => {
  const actual = jest.requireActual('./polygon-catalog');
  return {
    ...actual,
    POLYGON_ROUTES: {
      ...actual.POLYGON_ROUTES,
      'qa-admin': '/admin/users',
      'qa-protocol-relative': '//evil.example/qa/demo-shop',
      'qa-dotdot': '/qa/../admin/users',
    },
  };
});

import {
  resolvePolygonRoute,
  validatePolygonScenarioSteps,
} from './polygon-scenario';

describe('путь из таблицы мимо /qa/ не открывается', () => {
  it.each(['qa-admin', 'qa-protocol-relative'])(
    'резолвер: %s — отказ',
    (name) => {
      const res = resolvePolygonRoute(name, 'https://landing.example', 'ru');
      expect(res.ok).toBe(false);
    },
  );

  it.each(['qa-admin', 'qa-protocol-relative'])(
    'валидатор: %s — отказ',
    (name) => {
      const res = validatePolygonScenarioSteps(
        [{ kind: 'goto', route: name }],
        'site-tutorial-demo-1',
      );
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/не под \/qa\//);
    },
  );

  it('первый замок — префикс пути в таблице, с названной причиной', () => {
    const res = resolvePolygonRoute(
      'qa-admin',
      'https://landing.example',
      'ru',
    );
    expect(res).toEqual({
      ok: false,
      reason: expect.stringMatching(/не под \/qa\//),
    });
  });

  it('второй замок — собранный адрес: `/qa/../` уводит из /qa/ и отвергается', () => {
    const res = resolvePolygonRoute(
      'qa-dotdot',
      'https://landing.example',
      'ru',
    );
    expect(res).toEqual({
      ok: false,
      reason: expect.stringMatching(/ушёл с полигона/),
    });
  });

  it('настоящий маршрут по-прежнему открывается', () => {
    expect(
      resolvePolygonRoute('qa-demo-shop', 'https://landing.example', 'ru'),
    ).toEqual({
      ok: true,
      url: 'https://landing.example/qa/demo-shop?lang=ru',
    });
  });
});
