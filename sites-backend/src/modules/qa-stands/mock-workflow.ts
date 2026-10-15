import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { MockEntity } from './generated-contract';
import type { StandRecord } from './stand-contract';

export interface MockCondition {
  field: string;
  equals: string;
  related?: { entityId: string; viaField: string; matchField: string };
}
export interface MockWorkflow {
  entityId: string;
  stateField: string;
  initial: string;
  invalidateRelatedOnEdit?: boolean;
  transitions: Array<{
    id: string;
    title: string;
    from: string[];
    to: string;
    roles: Array<'editor' | 'admin'>;
    conditions: MockCondition[];
    seal: boolean;
    requireSeal: boolean;
    rotateCredentials?: boolean;
  }>;
}

/** Closed declarative language: no code, expressions, URLs or arbitrary paths. */
export function parseWorkflows(
  input: unknown,
  entities: MockEntity[],
): MockWorkflow[] {
  const bad = (): never => {
    throw new BadRequestException('Некорректные правила workflow стенда.');
  };
  const object = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : bad();
  const text = (v: unknown, max = 100): string =>
    typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : bad();
  const field = (e: MockEntity, v: unknown) => {
    const name = text(v, 60);
    return e.fields.find((f) => f.name === name) ?? bad();
  };
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 5) return bad();
  const workflows = input.map((value) => {
    const w = object(value),
      entityId = text(w.entityId, 40);
    const entity = entities.find((e) => e.id === entityId) ?? bad();
    const state = field(entity, w.stateField),
      initial = text(w.initial, 80);
    if (state.type !== 'select' || !state.options.includes(initial))
      return bad();
    if (
      !Array.isArray(w.transitions) ||
      !w.transitions.length ||
      w.transitions.length > 12
    )
      return bad();
    const transitions = w.transitions.map((value) => {
      const t = object(value),
        id = text(t.id, 40),
        title = text(t.title);
      if (!/^[a-z][a-z0-9_-]*$/.test(id)) return bad();
      if (!Array.isArray(t.from) || !t.from.length || t.from.length > 12)
        return bad();
      const from = t.from.map((v) => text(v, 80)),
        to = text(t.to, 80);
      if (
        [...from, to].some((v) => !state.options.includes(v)) ||
        (from.includes(to) && t.rotateCredentials !== true)
      )
        return bad();
      if (
        t.rotateCredentials !== undefined &&
        (typeof t.rotateCredentials !== 'boolean' ||
          (t.rotateCredentials &&
            (!entity.fields.some((f) => f.generated) ||
              t.seal ||
              t.requireSeal)))
      )
        return bad();
      if (
        !Array.isArray(t.roles) ||
        !t.roles.length ||
        t.roles.some((r) => !['editor', 'admin'].includes(r))
      )
        return bad();
      if (!Array.isArray(t.conditions) || t.conditions.length > 10)
        return bad();
      if (
        typeof t.seal !== 'boolean' ||
        typeof t.requireSeal !== 'boolean' ||
        (t.seal && t.requireSeal)
      )
        return bad();
      const conditions = t.conditions.map((value) => {
        const c = object(value),
          equals = text(c.equals, 500);
        let target = entity;
        let related: MockCondition['related'];
        if (c.related !== undefined) {
          const r = object(c.related);
          target = entities.find((e) => e.id === r.entityId) ?? bad();
          related = {
            entityId: target.id,
            viaField: field(entity, r.viaField).name,
            matchField: field(target, r.matchField).name,
          };
        }
        const f = field(target, c.field);
        if (f.type === 'select' && !f.options.includes(equals)) return bad();
        return { field: f.name, equals, ...(related ? { related } : {}) };
      });
      return {
        id,
        title,
        from,
        to,
        roles: t.roles as Array<'editor' | 'admin'>,
        conditions,
        seal: t.seal,
        requireSeal: t.requireSeal,
        ...(t.rotateCredentials !== undefined
          ? { rotateCredentials: t.rotateCredentials as boolean }
          : {}),
      };
    });
    if (new Set(transitions.map((t) => t.id)).size !== transitions.length)
      return bad();
    if (
      w.invalidateRelatedOnEdit !== undefined &&
      typeof w.invalidateRelatedOnEdit !== 'boolean'
    )
      return bad();
    return {
      entityId,
      stateField: state.name,
      initial,
      transitions,
      ...(w.invalidateRelatedOnEdit !== undefined
        ? { invalidateRelatedOnEdit: w.invalidateRelatedOnEdit as boolean }
        : {}),
    };
  });
  if (new Set(workflows.map((w) => w.entityId)).size !== workflows.length)
    return bad();
  for (const w of workflows) {
    const sealed = w.transitions.filter((t) => t.seal);
    for (const t of w.transitions.filter((t) => t.requireSeal)) {
      if (
        !sealed.some(
          (s) => JSON.stringify(s.conditions) === JSON.stringify(t.conditions),
        )
      )
        return bad();
    }
  }
  return workflows;
}

export function workflowEvidence(
  entities: MockEntity[],
  entity: MockEntity,
  item: StandRecord,
  records: StandRecord[],
  w: MockWorkflow,
  conditions: MockCondition[],
) {
  const failures: string[] = [],
    dependencies: unknown[] = [];
  for (const c of conditions) {
    let target = entity,
      row: StandRecord | undefined = item;
    if (c.related) {
      const relation = c.related;
      target = entities.find((e) => e.id === relation.entityId)!;
      const key =
        item.values[
          entity.fields.findIndex((f) => f.name === relation.viaField)
        ];
      const index = target.fields.findIndex(
        (f) => f.name === relation.matchField,
      );
      const matches = records.filter(
        (r) => r.entityId === target.id && r.values[index] === key,
      );
      row = matches.length === 1 ? matches[0] : undefined;
      dependencies.push(
        row
          ? [target.id, row.id, row.version ?? 1, row.values]
          : [target.id, 'missing_or_ambiguous'],
      );
    }
    if (
      !row ||
      row.values[target.fields.findIndex((f) => f.name === c.field)] !==
        c.equals
    )
      failures.push(`${target.title}: ${c.field} = ${c.equals}`);
  }
  const values = item.values.filter(
    (_, i) => entity.fields[i].name !== w.stateField,
  );
  const digest = createHash('sha256')
    .update(JSON.stringify([entity.id, item.id, values, dependencies]))
    .digest('hex');
  return { failures, digest };
}
