import { parseGenerated, type GeneratedContract } from './generated-contract';
import { BadRequestException } from '@nestjs/common';
import { workflowEvidence } from './mock-workflow';
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
  version?: number;
  approvalDigest?: string;
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
    transitionId?: string;
    expectedVersion?: number;
  };
  if (
    !o ||
    !['GET', 'POST', 'PATCH', 'TRANSITION', 'DELETE'].includes(
      o.method ?? '',
    ) ||
    !['viewer', 'editor', 'admin'].includes(o.role ?? '') ||
    !['normal', '500', '429', 'empty'].includes(o.scenario ?? 'normal')
  )
    throw new BadRequestException('Неизвестная команда mock API.');
  if (c.template === 'records' && ['PATCH', 'TRANSITION'].includes(o.method!))
    throw new BadRequestException(
      'Этот шаблон не поддерживает изменение и workflow.',
    );
  const entity =
    c.template === 'generated'
      ? c.entities.find((e) => e.id === o.entityId)
      : null;
  if (c.template === 'generated' && !entity)
    throw new BadRequestException('Выберите сущность mock API.');
  const fields = entity ? entity.fields.map((f) => f.name) : c.fields;
  const workflow =
    c.template === 'generated'
      ? c.workflows?.find((w) => w.entityId === entity?.id)
      : undefined;
  const stateIndex = workflow ? fields.indexOf(workflow.stateField) : -1;
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
  const existing = bucket.find((r) => r.id === o.id);
  const reject = (status: number, error: string, failures: string[] = []) => ({
    status,
    data: { error, failures },
    records,
    changed: false,
  });
  if (['PATCH', 'TRANSITION'].includes(o.method!)) {
    if (!entity || !existing) return reject(404, 'Запись не найдена');
    if (o.expectedVersion !== (existing.version ?? 1))
      return reject(409, 'Версия записи изменилась. Обновите список.');
  }
  if (o.method === 'TRANSITION') {
    if (!workflow || !existing || !entity || c.template !== 'generated')
      return reject(422, 'Workflow не настроен');
    const transition = workflow.transitions.find(
      (t) => t.id === o.transitionId,
    );
    if (!transition || !transition.from.includes(existing.values[stateIndex]))
      return reject(409, 'Переход недоступен из текущего состояния');
    if (!transition.roles.includes(o.role as 'editor' | 'admin'))
      return reject(403, 'Демо-роль не разрешает переход');
    const evidence = workflowEvidence(
      c.entities,
      entity,
      existing,
      records,
      workflow,
      transition.conditions,
    );
    if (evidence.failures.length)
      return reject(409, 'Условия перехода не выполнены', evidence.failures);
    if (transition.requireSeal && existing.approvalDigest !== evidence.digest)
      return reject(
        409,
        'Согласование отсутствует или устарело: текст либо связанные данные изменены',
      );
    const item = {
      ...existing,
      values: existing.values.map((v, i) =>
        i === stateIndex ? transition.to : v,
      ),
      version: (existing.version ?? 1) + 1,
      ...(transition.seal ? { approvalDigest: evidence.digest } : {}),
    };
    if (!transition.seal && !transition.requireSeal) delete item.approvalDigest;
    return {
      status: 200,
      data: item,
      records: records.map((r) => (r.id === item.id ? item : r)),
      changed: true,
    };
  }
  if (o.method === 'POST' || o.method === 'PATCH') {
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
    const values = o.values.map((x) => (x as string).trim());
    if (
      workflow &&
      values[stateIndex] !==
        (o.method === 'POST' ? workflow.initial : existing!.values[stateIndex])
    )
      return reject(422, 'Состояние меняется только через действие workflow');
    if (o.method === 'PATCH') {
      if (!entity || !existing) return reject(404, 'Запись не найдена');
      if (JSON.stringify(values) === JSON.stringify(existing.values))
        return { status: 200, data: existing, records, changed: false };
      if (workflow) values[stateIndex] = workflow.initial;
      const item: StandRecord = {
        id: existing.id,
        entityId: entity.id,
        values,
        version: (existing.version ?? 1) + 1,
      };
      return {
        status: 200,
        data: item,
        records: records.map((r) => (r.id === item.id ? item : r)),
        changed: true,
      };
    }
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
      values,
      ...(entity ? { version: 1 } : {}),
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
      checks: [
        ...c.entities.flatMap((e) => {
          const values = e.fields.map((f) =>
            f.type === 'number'
              ? '1'
              : f.type === 'email'
                ? 'demo@example.invalid'
                : f.type === 'select'
                  ? f.options[0]
                  : 'test',
          );
          const workflow = c.workflows?.find((w) => w.entityId === e.id);
          if (workflow)
            values[e.fields.findIndex((f) => f.name === workflow.stateField)] =
              workflow.initial;
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
        ...workflowChecks(c),
      ],
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

/** Isolated probes: preconditions are synthetic fixtures, never changes to saved data. */
function workflowChecks(c: GeneratedContract) {
  return (c.workflows ?? []).flatMap((w) =>
    w.transitions.flatMap((t) => {
      const entities = c.entities;
      const entity = entities.find((e) => e.id === w.entityId)!;
      const rows: StandRecord[] = entities.map((e) => ({
        id: 'probe-' + e.id,
        entityId: e.id,
        version: 1,
        values: e.fields.map((f) =>
          f.type === 'select'
            ? f.options[0]
            : f.type === 'email'
              ? 'qa@example.invalid'
              : f.type === 'number'
                ? '1'
                : 'test',
        ),
      }));
      const item = rows.find((r) => r.entityId === entity.id)!;
      item.values[entity.fields.findIndex((f) => f.name === w.stateField)] =
        t.from[0];
      for (const condition of t.conditions) {
        let e = entity,
          row = item;
        if (condition.related) {
          const rel = condition.related;
          e = entities.find((e) => e.id === rel.entityId)!;
          row = rows.find((r) => r.entityId === e.id)!;
          item.values[entity.fields.findIndex((f) => f.name === rel.viaField)] =
            'test';
          row.values[e.fields.findIndex((f) => f.name === rel.matchField)] =
            'test';
        }
        row.values[e.fields.findIndex((f) => f.name === condition.field)] =
          condition.equals;
      }
      const input = {
        method: 'TRANSITION',
        role: t.roles[0],
        entityId: entity.id,
        id: item.id,
        transitionId: t.id,
        expectedVersion: 1,
      };
      const checks: Array<{ name: string; passed: boolean }> = [];
      if (t.requireSeal) {
        checks.push({
          name: entity.title + ': ' + t.title + ' — без согласования отказ',
          passed: mockTransition(c, rows, input).status === 409,
        });
        item.approvalDigest = workflowEvidence(
          entities,
          entity,
          item,
          rows,
          w,
          t.conditions,
        ).digest;
      }
      const allowed = mockTransition(c, rows, input);
      checks.push({
        name: entity.title + ': ' + t.title,
        passed: allowed.status === 200,
      });
      checks.push({
        name: entity.title + ': ' + t.title + ' — viewer отказ',
        passed:
          mockTransition(c, rows, { ...input, role: 'viewer' }).status === 403,
      });
      if (t.conditions.length) {
        const badRows = rows.map((r) => ({
          ...r,
          values: r.values.map(() => 'invalid'),
        }));
        badRows.find((r) => r.id === item.id)!.values[
          entity.fields.findIndex((f) => f.name === w.stateField)
        ] = t.from[0];
        checks.push({
          name: entity.title + ': ' + t.title + ' — условия обязательны',
          passed: mockTransition(c, badRows, input).status === 409,
        });
      }
      return checks;
    }),
  );
}
