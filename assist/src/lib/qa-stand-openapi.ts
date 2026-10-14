import type { Stand } from './qa-stands-api';

/** Describe the existing REST transport; field values are ordered strings. */
export function standOpenApi(siteId: string, stand: Stand) {
  const base = `/qa/sites/${encodeURIComponent(siteId)}/stands/${encodeURIComponent(stand.id)}/mock/records`;
  const entities = stand.contract.entities ?? [];
  const entityIds = entities.map((entity) => entity.id);
  const entitySchema = entityIds.length
    ? { type: 'string', enum: entityIds }
    : { type: 'string' };
  const parameter = (name: string, schema: object, required = false) => ({
    name,
    in: 'query',
    required,
    schema,
  });
  const json = <T extends object>(schema: T) => ({
    'application/json': { schema },
  });
  const error = {
    description: 'Ошибка авторизации, проверки данных или сценария',
    content: json({ type: 'object', additionalProperties: true }),
  };
  const errors = Object.fromEntries(
    ['400', '401', '403', '404', '409', '422', '429', '500'].map((status) => [
      status,
      error,
    ])
  );
  const record = {
    type: 'object',
    required: ['id', 'values'],
    properties: {
      id: { type: 'string' },
      values: { type: 'array', items: { type: 'string', maxLength: 500 } },
      ...(entityIds.length ? { entityId: entitySchema } : {}),
    },
  };
  return {
    openapi: '3.0.3',
    info: {
      title: stand.contract.title,
      version: String(stand.contract.version),
      description: `${stand.contract.description}\nТребуется действующая авторизация кабинета и доступ к аккаунту/сайту. Демонстрационная role не заменяет права пользователя. Значения values[] передаются строками в порядке полей выбранной сущности. Экспорт не содержит токенов и пользовательских записей.`,
    },
    // Relative server uses the API origin where this specification is hosted/imported.
    servers: [
      { url: '/', description: 'Укажите адрес backend API при импорте' },
    ],
    'x-stand-fields': entities.length
      ? entities.map(({ id, title, fields }) => ({ id, title, fields }))
      : [
          {
            id: 'records',
            fields: stand.contract.fields.map((name) => ({
              name,
              type: 'text',
              required: true,
            })),
          },
        ],
    paths: {
      [base]: {
        get: {
          summary: 'Получить записи',
          parameters: [
            parameter('entity', entitySchema, !!entityIds.length),
            parameter('q', {
              type: 'string',
              description:
                'Поиск по значениям; учитываются первые 200 символов',
            }),
            parameter('scenario', {
              type: 'string',
              enum: ['normal', 'empty', '429', '500'],
              default: 'normal',
            }),
          ],
          responses: {
            '200': {
              description: 'Список записей',
              content: json({
                type: 'object',
                required: ['items'],
                properties: { items: { type: 'array', items: record } },
              }),
            },
            ...errors,
          },
        },
        post: {
          summary: 'Создать запись (права QA на запись)',
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              required: ['values', ...(entityIds.length ? ['entityId'] : [])],
              properties: {
                entityId: entitySchema,
                role: {
                  type: 'string',
                  enum: ['viewer', 'editor', 'admin'],
                  default: 'editor',
                },
                scenario: {
                  type: 'string',
                  enum: ['normal', 'empty', '429', '500'],
                  default: 'normal',
                },
                values: {
                  type: 'array',
                  items: { type: 'string', maxLength: 500 },
                  description:
                    'Количество и порядок соответствуют x-stand-fields. Числа и email также передаются строками.',
                },
              },
            }),
          },
          responses: {
            '201': { description: 'Созданная запись', content: json(record) },
            ...errors,
          },
        },
      },
      [`${base}/{recordId}`]: {
        delete: {
          summary:
            'Удалить запись (права QA на запись, демонстрационная роль admin)',
          parameters: [
            {
              name: 'recordId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
            parameter('entity', entitySchema, !!entityIds.length),
            parameter('role', {
              type: 'string',
              enum: ['viewer', 'editor', 'admin'],
              default: 'admin',
            }),
          ],
          responses: {
            '200': {
              description: 'Удалённая запись',
              content: json({
                type: 'object',
                required: ['deleted'],
                properties: { deleted: { type: 'string' } },
              }),
            },
            ...errors,
          },
        },
      },
    },
  };
}

export function downloadStandOpenApi(siteId: string, stand: Stand) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(standOpenApi(siteId, stand), null, 2)], {
      type: 'application/json',
    })
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'stand-openapi.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
