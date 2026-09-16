/**
 * route-templates.ts — резолвер имени маршрута сценария (шаг `goto`,
 * §4.10 ТЗ) в настоящий hash-путь TMA (`frontend/src/lib/router.ts`),
 * этап 97 (§5 ТЗ).
 *
 * ## Почему список маршрутов ЗДЕСЬ, а не импорт из frontend
 *
 * `frontend` и `backend` — отдельные Node-проекты (свои package.json/
 * tsconfig, разные раннтаймы — Vite-бандл в браузере и Nest на Vercel
 * Functions), кросс-импорта между ними в проекте нет нигде. Копия
 * `routes`/`Route['name']` из `frontend/src/lib/router.ts` ЗДЕСЬ —
 * осознанное дублирование, не оплошность: при изменении маршрутов
 * фронтенда эту таблицу нужно поправить руками. Список маршрутов в
 * продукте меняется редко (16 записей на сентябрь 2026, последний раз —
 * этап 88), а настоящий cross-package импорт стоил бы дороже, чем
 * изредка поправить одну таблицу.
 *
 * ## Почему не ВСЕ 20 маршрутов фронтенда
 *
 * Поддерживаются только те, для которых у фикстурного пользователя
 * (`scripts/seed-fixture-user.ts`, §3.3 ТЗ) реально есть данные:
 * проект, товар, манифест бренда, сессия с готовым роликом. Маршруты
 * вложенных прогонов (`catalog-batch`/`ab-test`/`feed-import` — свои id
 * партии/прогона, которых у фикстуры нет и не будет: это одноразовые
 * сущности, а не постоянные данные) и `legal`/`not-found` (не относятся
 * к обучающим сценариям мастера генерации) намеренно не резолвятся —
 * `unsupported`, с понятной причиной, а не тихая заглушка.
 *
 * ## Fail loudly на неизвестном имени
 *
 * До этапа 106 промпт генератора (`tutorial-scenario-prompt.ts`) называл
 * `route` плейсхолдером и в качестве ПРИМЕРА приводил несуществующее имя
 * — модель регулярно писала что-то вроде "wizard.generation"/
 * "wizard.step-8", 9 из 9 сгенерированных сценариев падали на первом же
 * шаге при реальном прогоне на проде. Промпт с этапа 106 передаёт модели
 * именно `ROUTE_DESCRIPTIONS` ниже как закрытый список, так что новые
 * сценарии в норме не должны попадать сюда вовсе — но резолвер всё равно
 * не пытается угадать похожее имя по историческим или ручным сценариям:
 * он явно говорит "не знаю такой маршрут", а сломанный сценарий
 * оператор удаляет кнопкой «Удалить» на «Сценарии обучалки»
 * (`TutorialScenarioAdminService.remove`, этап 106) — не чинит на лету,
 * это одноразовая генерация, дешевле перегенерировать, чем редактировать
 * JSON шагов вручную.
 */

/** Реальные ID фикстурных данных, известные оператору только в рантайме
 * (заведены `seed-fixture-user.ts`, резолвятся сервисом-оркестратором
 * из БД по фикстурному пользователю — см. `tutorial-scenario-runner.
 * service.ts`, этот файл о самих ID ничего не знает). */
export interface FixtureRouteContext {
  projectId?: string;
  itemId?: string;
  manifestId?: string;
  sessionId?: string;
}

export type RouteResolution =
  | { ok: true; path: string }
  | { ok: false; reason: string };

type RouteBuilder = (ctx: FixtureRouteContext) => RouteResolution;

function missingFixtureData(what: string): RouteResolution {
  return {
    ok: false,
    reason: `для этого маршрута нужны фикстурные данные (${what}), которых нет у фикстурного пользователя — проверьте scripts/seed-fixture-user.ts`,
  };
}

function unsupported(reason: string): RouteResolution {
  return {
    ok: false,
    reason: `маршрут пока не поддержан исполнителем: ${reason}`,
  };
}

/**
 * Человекочитаемые описания поддерживаемых ключей — единственный
 * источник правды для промпта генератора сценариев
 * (`tutorial-scenario-prompt.ts`, см. находку того же этапа: раньше
 * промпт называл "route" плейсхолдером и предлагал модели придумывать
 * что-то вроде "wizard.generation"/"wizard.step-8" — таких маршрутов
 * никогда не существовало, каждый сгенерированный сценарий падал на
 * первом же шаге). Мастер создания ролика (`generate`) и экран одного
 * товара (`item`) — однастраничные с шагами внутри (React-состояние, не
 * отдельные URL) — целых 9 из 10 шагов обучалки описывают то, что
 * происходит ВНУТРИ этих двух экранов, не отдельные маршруты.
 */
export const ROUTE_DESCRIPTIONS: Record<string, string> = {
  projects: 'список всех проектов пользователя',
  'project-new': 'создание нового проекта',
  project: 'карточка одного проекта — список товаров в нём',
  item: 'экран одного товара: фото → аналоги → голосовое описание → цена — все шаги ОДНОГО товара внутри этого экрана, не отдельные маршруты',
  generate:
    'весь мастер создания рекламного ролика для сессии: выбор референса → разбор ИИ → проверка релевантности → состав кадра → промпт → формат и референс-картинки → рендер (Grok/Veo) → проверка результата — ВСЕ эти шаги происходят на одном этом экране, переключение между ними не меняет маршрут',
  postprod: 'Постпродакшн — список всех готовых роликов пользователя',
  'postprod-video':
    'один конкретный готовый ролик — смена реплик/голоса, экспорт',
  manifests: 'список манифестов бренда',
  'manifest-new': 'создание манифеста бренда',
  manifest: 'один манифест бренда — голос, персонажи, стиль',
  plan: 'тариф и лимиты',
  channels: 'подключённые каналы публикации (YouTube/TikTok)',
  credits: 'баланс и история списаний',
  feed: 'импорт товаров фидом',
};

/** Копия `routes` из `frontend/src/lib/router.ts` — только пути, без
 * React/hash-навигации, см. доккомментарий файла. */
const ROUTE_BUILDERS: Record<string, RouteBuilder> = {
  projects: () => ({ ok: true, path: '/projects' }),
  'project-new': () => ({ ok: true, path: '/projects/new' }),
  project: (ctx) =>
    ctx.projectId
      ? { ok: true, path: `/projects/${ctx.projectId}` }
      : missingFixtureData('projectId'),
  item: (ctx) =>
    ctx.projectId && ctx.itemId
      ? {
          ok: true,
          path: `/projects/${ctx.projectId}/items/${ctx.itemId}`,
        }
      : missingFixtureData('projectId, itemId'),
  generate: () => ({ ok: true, path: '/generate' }),
  postprod: () => ({ ok: true, path: '/postprod' }),
  'postprod-video': (ctx) =>
    ctx.sessionId
      ? { ok: true, path: `/postprod/${ctx.sessionId}` }
      : missingFixtureData('sessionId'),
  manifests: () => ({ ok: true, path: '/brand-manifests' }),
  'manifest-new': () => ({ ok: true, path: '/brand-manifests/new' }),
  manifest: (ctx) =>
    ctx.manifestId
      ? { ok: true, path: `/brand-manifests/${ctx.manifestId}` }
      : missingFixtureData('manifestId'),
  plan: () => ({ ok: true, path: '/plan' }),
  channels: () => ({ ok: true, path: '/channels' }),
  credits: () => ({ ok: true, path: '/credits' }),
  feed: () => ({ ok: true, path: '/feed' }),
  'catalog-batch-start': () =>
    unsupported('партии пакетной генерации не входят в фикстурные данные'),
  'catalog-batch': () =>
    unsupported('партии пакетной генерации не входят в фикстурные данные'),
  'ab-test': () =>
    unsupported('прогоны A/B-теста не входят в фикстурные данные'),
  'feed-import-start': () =>
    unsupported('прогоны импорта фида не входят в фикстурные данные'),
  'feed-import': () =>
    unsupported('прогоны импорта фида не входят в фикстурные данные'),
  legal: () => unsupported('правовые страницы не относятся к обучалке мастера'),
  'not-found': () => unsupported('служебный маршрут, не экран продукта'),
};

/**
 * Резолвит имя маршрута в hash-путь. Возвращает путь БЕЗ `#` и без
 * домена — вызывающий (`tutorial-scenario-runner.service.ts`) склеивает
 * его с `TMA_PUBLIC_URL`.
 */
export function resolveScenarioRoute(
  routeName: string,
  ctx: FixtureRouteContext,
): RouteResolution {
  const builder = ROUTE_BUILDERS[routeName];
  if (!builder) {
    return {
      ok: false,
      reason: `неизвестное имя маршрута — нет такого в frontend/src/lib/router.ts (проверьте список поддерживаемых имён в route-templates.ts)`,
    };
  }
  return builder(ctx);
}
