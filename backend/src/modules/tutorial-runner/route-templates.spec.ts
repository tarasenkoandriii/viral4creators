import { resolveScenarioRoute, ROUTE_DESCRIPTIONS } from './route-templates';

/** Заведомо неподдержанные (§4.10 ТЗ — не входят в фикстурные данные или
 * не относятся к обучалке мастера) — не должны попадать в
 * `ROUTE_DESCRIPTIONS`, иначе промпт предложит модели маршрут, который
 * тут же откажет как "не поддержан исполнителем". */
const KNOWN_UNSUPPORTED = [
  'catalog-batch-start',
  'catalog-batch',
  'ab-test',
  'feed-import-start',
  'feed-import',
  'legal',
  'not-found',
  // Этап F ТЗ `docs-tz/TZ-Enterprise-Tutorial-Landing.md`: маршрут
  // существует и параметров не требует, но фикстурный пользователь не
  // тестировщик — обход снял бы экран отказа в доступе и записал бы его
  // как «экран продукта».
  'testing',
];

/** Маршруты, которые резолвятся В ПРИНЦИПЕ, но фикстурных данных для них
 *  нет — значит в `ROUTE_DESCRIPTIONS` им не место: предложенный модели
 *  маршрут, который потом откажет на прогоне, это ровно та поломка, из-за
 *  которой описания вообще завели (см. доккомментарий route-templates). */
const NO_FIXTURE_DATA = ['greeting-video'];

describe('resolveScenarioRoute', () => {
  it('маршруты без параметров резолвятся без фикстурного контекста', () => {
    expect(resolveScenarioRoute('generate', {})).toEqual({
      ok: true,
      path: '/generate',
    });
    expect(resolveScenarioRoute('postprod', {})).toEqual({
      ok: true,
      path: '/postprod',
    });
    expect(resolveScenarioRoute('plan', {})).toEqual({
      ok: true,
      path: '/plan',
    });
  });

  it('project — резолвится с projectId из фикстурного контекста', () => {
    expect(resolveScenarioRoute('project', { projectId: 'p1' })).toEqual({
      ok: true,
      path: '/projects/p1',
    });
  });

  it('project — без projectId в контексте отказывает с понятной причиной', () => {
    const result = resolveScenarioRoute('project', {});
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain('projectId');
  });

  it('item — требует и projectId, и itemId', () => {
    expect(
      resolveScenarioRoute('item', { projectId: 'p1', itemId: 'i1' }),
    ).toEqual({ ok: true, path: '/projects/p1/items/i1' });
    expect(resolveScenarioRoute('item', { projectId: 'p1' }).ok).toBe(false);
  });

  it('postprod-video — требует sessionId', () => {
    expect(resolveScenarioRoute('postprod-video', { sessionId: 's1' })).toEqual(
      { ok: true, path: '/postprod/s1' },
    );
    expect(resolveScenarioRoute('postprod-video', {}).ok).toBe(false);
  });

  it('manifest — требует manifestId', () => {
    expect(resolveScenarioRoute('manifest', { manifestId: 'm1' })).toEqual({
      ok: true,
      path: '/brand-manifests/m1',
    });
  });

  it('неизвестное (галлюцинированное) имя маршрута — явный отказ, не угадывание', () => {
    const result = resolveScenarioRoute('wizard.generation', {});
    expect(result.ok).toBe(false);
    const reason = (result as { reason: string }).reason;
    // Имя обязано попасть в текст: без него оператор не знает, ЧТО
    // именно не нашлось, когда в сценарии тридцать шагов.
    expect(reason).toContain('wizard.generation');
    // И главное — сообщение больше не утверждает, что маршрута нет во
    // фронтенде. В половине случаев это была неправда: отставала копия
    // таблицы здесь, а оператор шёл искать опечатку в сценарии.
    expect(reason).not.toMatch(/нет такого в frontend/);
    expect(reason).toContain('route-templates.ts');
  });

  it('site-tutorial — резолвится по проекту ТРЕТЬЕГО типа, а не по рекламному', () => {
    expect(
      resolveScenarioRoute('site-tutorial', { clientSiteProjectId: 'cs1' }),
    ).toEqual({ ok: true, path: '/projects/cs1/site-tutorial' });
    // Рекламного projectId для него недостаточно: у того проекта нет
    // черновика обучалки, и визард открылся бы в пустоту.
    const withAdProject = resolveScenarioRoute('site-tutorial', {
      projectId: 'p1',
    });
    expect(withAdProject.ok).toBe(false);
    expect((withAdProject as { reason: string }).reason).toContain(
      'clientSiteProjectId',
    );
  });

  it('greeting-video — требует свой проект, рекламный не подходит', () => {
    expect(
      resolveScenarioRoute('greeting-video', { greetingProjectId: 'g1' }),
    ).toEqual({ ok: true, path: '/projects/g1/greeting-video' });
    expect(resolveScenarioRoute('greeting-video', { projectId: 'p1' }).ok).toBe(
      false,
    );
  });

  it('api-keys и invite — маршруты без параметров', () => {
    expect(resolveScenarioRoute('api-keys', {})).toEqual({
      ok: true,
      path: '/api-keys',
    });
    expect(resolveScenarioRoute('invite', {})).toEqual({
      ok: true,
      path: '/invite',
    });
  });

  it('testing — отказ с причиной про доступ, а не «неизвестное имя»', () => {
    const result = resolveScenarioRoute('testing', {});
    expect(result.ok).toBe(false);
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain('тестировщик');
    expect(reason).not.toContain('не найдено');
  });

  it('маршруты вложенных прогонов (catalog-batch/ab-test/feed-import) — явно не поддержаны, не молчаливая заглушка', () => {
    for (const route of [
      'catalog-batch-start',
      'catalog-batch',
      'ab-test',
      'feed-import-start',
      'feed-import',
    ]) {
      const result = resolveScenarioRoute(route, {
        projectId: 'p1',
        itemId: 'i1',
        manifestId: 'm1',
        sessionId: 's1',
      });
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toContain('не поддержан');
    }
  });
});

describe('ROUTE_DESCRIPTIONS — единственный источник правды для промпта генератора (этап 106)', () => {
  it('каждый описанный ключ реально резолвится (с полным фикстурным контекстом)', () => {
    const fullCtx = {
      projectId: 'p1',
      itemId: 'i1',
      manifestId: 'm1',
      sessionId: 's1',
      clientSiteProjectId: 'cs1',
    };
    for (const key of Object.keys(ROUTE_DESCRIPTIONS)) {
      expect(resolveScenarioRoute(key, fullCtx).ok).toBe(true);
    }
  });

  it('не содержит ни одного заведомо неподдержанного ключа', () => {
    for (const key of KNOWN_UNSUPPORTED) {
      expect(ROUTE_DESCRIPTIONS[key]).toBeUndefined();
    }
  });

  it('не предлагает маршруты, под которые нет фикстурных данных', () => {
    for (const key of NO_FIXTURE_DATA) {
      expect(ROUTE_DESCRIPTIONS[key]).toBeUndefined();
      // При этом сам билдер существовать обязан: иначе отказ был бы
      // «неизвестное имя», а это другая причина и другое действие
      // оператора.
      const result = resolveScenarioRoute(key, {});
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toContain(
        'фикстурные данные',
      );
    }
  });
});
