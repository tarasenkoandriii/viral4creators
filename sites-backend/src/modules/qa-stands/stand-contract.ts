import { parseGenerated, type GeneratedContract } from './generated-contract';
import { BadRequestException } from '@nestjs/common';
export interface TemplateContract {
  title: string;
  description: string;
  fields: string[];
  template: 'records';
  version: 1;
}
export type StandContract = TemplateContract | GeneratedContract;
export function planStand(input: unknown): StandContract {
  if (
    input &&
    typeof input === 'object' &&
    (input as { template?: string }).template === 'generated'
  )
    return parseGenerated(
      input,
      (input as { description: string }).description,
    );
  const o = input as { description?: unknown; title?: unknown };
  if (
    !o ||
    typeof o.description !== 'string' ||
    o.description.trim().length < 10 ||
    o.description.length > 4000
  )
    throw new BadRequestException('Описание: от 10 до 4000 символов.');
  const title =
    typeof o.title === 'string' ? o.title.trim() : 'Тестовый кабинет';
  if (!title || title.length > 100)
    throw new BadRequestException('Название: от 1 до 100 символов.');
  const match = o.description.match(/(?:поля|fields)\s*:\s*([^\n.;]+)/i);
  const fields = match
    ? match[1]
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : ['Название', 'Описание'];
  if (
    !fields.length ||
    fields.length > 8 ||
    fields.some((x) => x.length > 60) ||
    new Set(fields).size !== fields.length
  )
    throw new BadRequestException('Укажите до 8 разных полей через запятую.');
  return {
    title,
    description: o.description.trim(),
    fields,
    template: 'records',
    version: 1,
  };
}
export interface StandRecord {
  id: string;
  values: string[];
  entityId?: string;
}
export function baseline(c: StandContract): StandRecord[] {
  if (c.template === 'generated') return [];
  return [
    {
      id: 'demo-1',
      values: c.fields.map((_, i) =>
        i === 0 ? 'Пример записи' : 'Тестовые данные',
      ),
    },
  ];
}
export function mockTransition(
  c: StandContract,
  records: StandRecord[],
  input: unknown,
) {
  const o = input as {
    entityId?: string;
    method?: string;
    role?: string;
    values?: unknown;
    id?: string;
    scenario?: string;
    query?: string;
  };
  if (
    !o ||
    !['GET', 'POST', 'DELETE'].includes(o.method ?? '') ||
    !['viewer', 'editor', 'admin'].includes(o.role ?? '') ||
    !['normal', '500', '429', 'empty'].includes(o.scenario ?? 'normal')
  )
    throw new BadRequestException('Неизвестная команда mock API.');
  const entity =
    c.template === 'generated'
      ? c.entities.find((e) => e.id === o.entityId)
      : null;
  if (c.template === 'generated' && !entity)
    throw new BadRequestException('Выберите сущность mock API.');
  const fields = entity ? entity.fields.map((f) => f.name) : c.fields;
  const bucket = entity
    ? records.filter((r) => r.entityId === entity.id)
    : records;
  if (o.scenario === '500' || o.scenario === '429')
    return {
      status: Number(o.scenario),
      data: { error: 'Смоделированная ошибка' },
      records,
      changed: false,
    };
  if (o.method === 'GET')
    return {
      status: 200,
      data: {
        items:
          o.scenario === 'empty'
            ? []
            : bucket.filter((r) =>
                r.values
                  .join(' ')
                  .toLowerCase()
                  .includes(
                    String(o.query ?? '')
                      .slice(0, 200)
                      .toLowerCase(),
                  ),
              ),
      },
      records,
      changed: false,
    };
  if (o.role === 'viewer' || (o.method === 'DELETE' && o.role !== 'admin'))
    return {
      status: 403,
      data: { error: 'Демонстрационная роль не разрешает действие' },
      records,
      changed: false,
    };
  if (o.method === 'POST') {
    if (
      !Array.isArray(o.values) ||
      o.values.length !== fields.length ||
      o.values.some(
        (x) =>
          typeof x !== 'string' || (!entity && !x.trim()) || x.length > 500,
      )
    )
      return {
        status: 422,
        data: { error: 'Заполните все поля (до 500 символов)' },
        records,
        changed: false,
      };
    if (
      entity &&
      o.values.some((value, index) => {
        const f = entity.fields[index],
          v = String(value).trim();
        return (
          (f.required && !v) ||
          (v && f.type === 'number' && !Number.isFinite(Number(v))) ||
          (v && f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) ||
          (v && f.type === 'select' && !f.options.includes(v))
        );
      })
    )
      return {
        status: 422,
        data: { error: 'Проверьте обязательные поля и типы данных' },
        records,
        changed: false,
      };
    if (records.length >= 100)
      return {
        status: 409,
        data: { error: 'Лимит: 100 записей' },
        records,
        changed: false,
      };
    const item = {
      id: crypto.randomUUID(),
      ...(entity ? { entityId: entity.id } : {}),
      values: o.values.map((x) => (x as string).trim()),
    };
    return {
      status: 201,
      data: item,
      records: [...records, item],
      changed: true,
    };
  }
  const item = bucket.find((r) => r.id === o.id);
  if (!item)
    return {
      status: 404,
      data: { error: 'Запись не найдена' },
      records,
      changed: false,
    };
  return {
    status: 200,
    data: { deleted: item.id },
    records: records.filter((r) => r.id !== item.id),
    changed: true,
  };
}
export function checkStand(c: StandContract) {
  if (c.template === 'generated')
    return {
      scope: 'Проверка контрактов всех сущностей; данные стенда не меняются.',
      checks: c.entities.flatMap((e) => {
        const values = e.fields.map((f) =>
          f.type === 'number'
            ? '1'
            : f.type === 'email'
              ? 'demo@example.invalid'
              : f.type === 'select'
                ? f.options[0]
                : 'test',
        );
        const created = mockTransition(c, [], {
          method: 'POST',
          role: 'editor',
          entityId: e.id,
          values,
        });
        const denied = mockTransition(c, [], {
          method: 'POST',
          role: 'viewer',
          entityId: e.id,
          values,
        });
        const deleted = mockTransition(c, created.records, {
          method: 'DELETE',
          role: 'admin',
          entityId: e.id,
          id: created.records[0]?.id,
        });
        return [
          { name: e.title + ': создание', passed: created.status === 201 },
          { name: e.title + ': роли', passed: denied.status === 403 },
          {
            name: e.title + ': удаление',
            passed: deleted.status === 200 && deleted.records.length === 0,
          },
        ];
      }),
    };
  const seed = baseline(c);
  const read = mockTransition(c, seed, { method: 'GET', role: 'viewer' });
  const denied = mockTransition(c, seed, {
    method: 'POST',
    role: 'viewer',
    values: c.fields.map(() => 'test'),
  });
  const invalid = mockTransition(c, seed, {
    method: 'POST',
    role: 'editor',
    values: [],
  });
  const created = mockTransition(c, seed, {
    method: 'POST',
    role: 'editor',
    values: c.fields.map(() => 'test'),
  });
  const deleted = mockTransition(c, created.records, {
    method: 'DELETE',
    role: 'admin',
    id: created.records.at(-1)?.id,
  });
  const failure = mockTransition(c, seed, {
    method: 'GET',
    role: 'viewer',
    scenario: '500',
  });
  return {
    scope:
      'Изолированная проверка контракта mock engine; без изменения данных стенда. Браузерная вёрстка не проверяется.',
    checks: [
      { name: 'Чтение', passed: read.status === 200 },
      {
        name: 'Ограничение роли',
        passed: denied.status === 403 && !denied.changed,
      },
      { name: 'Валидация', passed: invalid.status === 422 },
      {
        name: 'Создание',
        passed:
          created.status === 201 && created.records.length === seed.length + 1,
      },
      {
        name: 'Удаление',
        passed:
          deleted.status === 200 && deleted.records.length === seed.length,
      },
      {
        name: 'Ошибка сервера',
        passed: failure.status === 500 && !failure.changed,
      },
      {
        name: 'Сброс',
        passed: JSON.stringify(seed) === JSON.stringify(baseline(c)),
      },
    ],
  };
}
