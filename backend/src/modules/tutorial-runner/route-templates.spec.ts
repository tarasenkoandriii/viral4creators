import {
  FRESH_WIZARD_ROUTE,
  resolveScenarioRoute,
  ROUTE_DESCRIPTIONS,
  SEEDED_SESSION_ROUTES,
} from './route-templates';

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
  // «Я в кадре»: за флагом и начинается с камеры — снимать нечего.
  'persona',
];

/** Маршруты, которые резолвятся В ПРИНЦИПЕ, но фикстурных данных для них
 *  нет — значит в `ROUTE_DESCRIPTIONS` им не место: предложенный модели
 *  маршрут, который потом откажет на прогоне, это ровно та поломка, из-за
 *  которой описания вообще завели (см. доккомментарий route-templates). */
/**
 * Маршруты, которые резолвятся, но НЕ предлагаются модели, потому что
 * фикстурных данных под них нет.
 *
 * С 29.09.2026 список пуст: фикстура завела три проекта-поздравления, и
 * `greeting-video` из «резолвится, но не предлагается» переехал в
 * обычные описанные маршруты. Массив оставлен, а не удалён: проверка
 * ниже — про ПРАВИЛО («описан ⇒ есть данные»), а не про конкретное имя,
 * и следующий маршрут без фикстуры впишется сюда, а не заведёт вторую
 * такую же проверку.
 */
const NO_FIXTURE_DATA: string[] = [];

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

  it('persona — отказ с причиной про флаг и камеру, а не «неизвестное имя»', () => {
    const result = resolveScenarioRoute('persona', {});
    expect(result.ok).toBe(false);
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain('PERSONA_ENABLED');
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
      promptPendingSessionId: 's2',
      readyToRenderSessionId: 's3',
      clientSiteProjectId: 'cs1',
      greetingProjectId: 'g1',
      greetingDraftingProjectId: 'g2',
      greetingReadyProjectId: 'g3',
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

/**
 * Псевдоним мастера на ПРОЙДЕННОЙ сессии — находка второго боевого
 * прогона 29.09.2026 (см. доккомментарий `SEEDED_SESSION_ROUTES`).
 */
describe('generate-ready', () => {
  it('ведёт на тот же путь, что и чистый мастер — отличается подсев, не URL', () => {
    expect(resolveScenarioRoute('generate-ready', { sessionId: 's1' })).toEqual(
      {
        ok: true,
        path: '/generate',
      },
    );
    expect(resolveScenarioRoute('generate', {})).toEqual({
      ok: true,
      path: '/generate',
    });
  });

  it('без фикстурной сессии отказывает НАЗВАННОЙ причиной, а не открывает пустой мастер', () => {
    const resolved = resolveScenarioRoute('generate-ready', {});
    expect(resolved.ok).toBe(false);
    expect(resolved.ok ? '' : resolved.reason).toContain('sessionId');
  });

  it('объявлен и в описаниях для модели, и в списке маршрутов с подсевом', () => {
    expect(ROUTE_DESCRIPTIONS['generate-ready']).toBeDefined();
    expect(SEEDED_SESSION_ROUTES.has('generate-ready')).toBe(true);
    // Чистый мастер подсева НЕ требует: иначе шаги 1–2 открывались бы
    // на готовой сессии и падали бы на `reference-card`.
    expect(SEEDED_SESSION_ROUTES.has(FRESH_WIZARD_ROUTE)).toBe(false);
    expect(FRESH_WIZARD_ROUTE).toBe('generate');
  });

  it('описание чистого мастера прямо ограничивает его шагами 1–2', () => {
    // Без этого модель читала «весь мастер … ВСЕ эти шаги происходят на
    // одном экране» как приглашение ждать карточку разбора сразу после
    // `goto generate` — и шесть сценариев из девяти падали на `waitFor`.
    expect(ROUTE_DESCRIPTIONS.generate).toContain('1–2');
  });

  /**
   * Разбор достижимости 29.09.2026. Прежний тест требовал, чтобы
   * описание `generate-ready` обещало «шаги 3–9», — и обещание было
   * ложным: десять хуков этих шагов на готовой сессии не появляются
   * никогда. Тест закреплял неверное утверждение, потому что проверял
   * СЛОВА описания, а не то, что за ними стоит.
   *
   * Теперь проверяется структура: на каждое состояние сессии — своё
   * имя маршрута, и описание `generate-ready` обязано называть, чего
   * на нём НЕТ. Отрицание здесь важнее перечисления: модель ошибается
   * не тем, что не найдёт нужный экран, а тем, что будет ждать
   * элемент на экране, где его не бывает.
   */
  it('у каждого состояния сессии своё имя маршрута', () => {
    expect(ROUTE_DESCRIPTIONS['generate-prompt-pending']).toBeDefined();
    expect(ROUTE_DESCRIPTIONS['generate-ready-to-render']).toBeDefined();
    expect(SEEDED_SESSION_ROUTES.get('generate-prompt-pending')).toBe(
      'promptPendingSessionId',
    );
    expect(SEEDED_SESSION_ROUTES.get('generate-ready-to-render')).toBe(
      'readyToRenderSessionId',
    );
    expect(SEEDED_SESSION_ROUTES.get('generate-ready')).toBe('sessionId');
    // Три подсева — три РАЗНЫХ поля контекста. Одно и то же поле у
    // двух маршрутов означало бы два имени одного экрана, то есть
    // ровно ту неоднозначность, ради ухода от которой всё и затеяно.
    expect(new Set(SEEDED_SESSION_ROUTES.values()).size).toBe(
      SEEDED_SESSION_ROUTES.size,
    );
  });

  it('описание готовой сессии называет, чего на ней НЕ БУДЕТ', () => {
    const desc = ROUTE_DESCRIPTIONS['generate-ready'];
    expect(desc).toContain('НЕТ И НЕ БУДЕТ');
    expect(desc).toContain('релевантности');
    expect(desc).toContain('рендера');
  });

  it('маршруты недостающих состояний объявлены единственными для своих экранов', () => {
    expect(ROUTE_DESCRIPTIONS['generate-prompt-pending']).toContain(
      'Единственный маршрут',
    );
    expect(ROUTE_DESCRIPTIONS['generate-ready-to-render']).toContain(
      'Единственный маршрут',
    );
    // Платный рендер: запрет обязан стоять в описании маршрута, а не
    // только в общих правилах — именно здесь кнопка становится видимой
    // впервые.
    expect(ROUTE_DESCRIPTIONS['generate-ready-to-render']).toContain(
      'ЗАПРЕЩЕНО',
    );
  });
});
