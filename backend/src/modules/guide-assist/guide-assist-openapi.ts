/**
 * OpenAPI 3.0 эндпоинтов фактов гида — для импорта коннектора «Админки»
 * (Э7: кабинет → «Помощник сотрудников» → «API» → импорт по URL).
 *
 * Все операции — `GET` без побочных эффектов: автоклассификация платформы
 * (`openapi-import.ts` `classifyOperation`) обязана дать `read`. Поэтому в
 * operationId нет глаголов-действий, а в описаниях — слов «создаёт /
 * изменяет / отправляет» (тест `guide-assist-openapi.spec.ts` сверяет).
 * Действий (`write`/`danger`) генератор «Админке» не даёт вовсе: переходы и
 * заполнение полей делает исполнитель интерфейса (Э6-бис (б)) с правилами
 * «никогда», а оплата, удаление и запуск рендера — только руками человека
 * (решение Р-Ш6-3).
 *
 * Чистый модуль.
 */

export const GUIDE_FACTS_BASE_PATH = '/guide-assist/v1';

/**
 * Базовый URL API для `servers[0]`: `API_PUBLIC_URL` (уже с `/api`) +
 * `/guide-assist/v1`. Платформа принимает только https:443.
 */
export function factsServerUrl(
  apiPublicUrl: string | undefined,
): string | null {
  const base = (apiPublicUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}${GUIDE_FACTS_BASE_PATH}`;
}

const FACTS_NOTE =
  'Факты словами, без значений полей: названия, имена и тексты пользователя не передаются.';

export function buildGuideOpenApi(serverUrl: string): Record<string, unknown> {
  const projectParam = {
    name: 'projectId',
    in: 'path',
    required: true,
    description: 'id проекта из списка проектов пользователя',
    schema: { type: 'string', maxLength: 64 },
  };
  const err = { description: 'Нет доступа или проекта' };
  return {
    openapi: '3.0.3',
    info: {
      title: 'Viral4Creators — факты мастера для помощника',
      version: '1',
      description:
        'Только чтение. Пользователь определяется заголовком X-V4C-Actor (sub его employee-JWT); чужие проекты — 404. ' +
        FACTS_NOTE,
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        connectorKey: { type: 'http', scheme: 'bearer' },
      },
    },
    security: [{ connectorKey: [] }],
    paths: {
      '/projects': {
        get: {
          operationId: 'listProjects',
          summary: 'Проекты пользователя',
          description:
            'До 20 последних проектов: id, номер, тип, сценарий мастера и давность. Названий нет. ' +
            FACTS_NOTE,
          responses: { '200': { description: 'Список проектов' }, '401': err },
        },
      },
      '/projects/{projectId}/facts': {
        get: {
          operationId: 'getProjectFacts',
          summary: 'Состояние проекта в мастере',
          description:
            'Сценарий, шаги мастера (цель шага и data-assist-id кнопки шага) и факты состояния словами. ' +
            FACTS_NOTE,
          parameters: [projectParam],
          responses: {
            '200': { description: 'Факты проекта' },
            '401': err,
            '404': err,
          },
        },
      },
      '/account': {
        get: {
          operationId: 'getAccountSummary',
          summary: 'Сводка аккаунта',
          description: 'Тариф (LITE | STANDARD | PREMIUM) и число проектов.',
          responses: { '200': { description: 'Сводка' }, '401': err },
        },
      },
    },
  };
}
