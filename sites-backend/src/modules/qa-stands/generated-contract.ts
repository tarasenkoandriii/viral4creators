import { BadRequestException } from '@nestjs/common';
import { parseWorkflows, type MockWorkflow } from './mock-workflow';
export interface MockField {
  name: string;
  type: 'text' | 'number' | 'email' | 'select' | 'url' | 'datetime';
  required: boolean;
  options: string[];
  generated?: 'mock-key' | 'mock-secret';
  min?: number;
  max?: number;
  unique?: boolean;
}
export interface MockEntity {
  id: string;
  title: string;
  fields: MockField[];
}
export interface MockScreen {
  id: string;
  title: string;
  kind: 'list' | 'form' | 'dashboard';
  entityId: string;
  nextScreenId: string | null;
}
export interface GeneratedContract {
  title: string;
  description: string;
  fields: string[];
  template: 'generated';
  version: 2;
  entities: MockEntity[];
  screens: MockScreen[];
  assumptions: string[];
  workflows?: MockWorkflow[];
}
const bad = () =>
  new BadRequestException(
    'Контракт генератора не прошёл проверку. Уточните описание.',
  );
function obj(x: unknown): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw bad();
  return x as Record<string, unknown>;
}
function text(x: unknown, max = 100) {
  if (typeof x !== 'string' || !x.trim() || x.length > max) throw bad();
  return x.trim();
}
function id(x: unknown) {
  const v = text(x, 40);
  if (
    !/^[a-z][a-z0-9_-]*$/.test(v) ||
    ['__proto__', 'prototype', 'constructor'].includes(v)
  )
    throw bad();
  return v;
}
function list(x: unknown, max: number) {
  if (!Array.isArray(x) || !x.length || x.length > max) throw bad();
  return x;
}
function unique(xs: string[]) {
  if (new Set(xs).size !== xs.length) throw bad();
}
export function parseGenerated(
  input: unknown,
  description: string,
): GeneratedContract {
  const o = obj(input);
  const entities = list(o.entities, 5).map((value) => {
    const e = obj(value);
    const fields = list(e.fields, 8).map((value) => {
      const f = obj(value);
      if (
        !['text', 'number', 'email', 'select', 'url', 'datetime'].includes(
          String(f.type),
        ) ||
        typeof f.required !== 'boolean'
      )
        throw bad();
      const options =
        f.type === 'select' ? list(f.options, 12).map((x) => text(x, 80)) : [];
      unique(options);
      if (
        f.generated !== undefined &&
        (f.type !== 'text' ||
          !['mock-key', 'mock-secret'].includes(String(f.generated)))
      )
        throw bad();
      for (const key of ['min', 'max'] as const)
        if (
          f[key] !== undefined &&
          (f.type !== 'number' ||
            typeof f[key] !== 'number' ||
            !Number.isFinite(f[key]) ||
            Math.abs(f[key] as number) > 1e12)
        )
          throw bad();
      if (
        typeof f.min === 'number' &&
        typeof f.max === 'number' &&
        f.min > f.max
      )
        throw bad();
      if (f.unique !== undefined && typeof f.unique !== 'boolean') throw bad();
      return {
        name: text(f.name, 60),
        type: f.type as MockField['type'],
        required: f.required,
        options,
        ...(f.generated !== undefined
          ? { generated: f.generated as MockField['generated'] }
          : {}),
        ...(f.min !== undefined ? { min: f.min as number } : {}),
        ...(f.max !== undefined ? { max: f.max as number } : {}),
        ...(f.unique !== undefined ? { unique: f.unique as boolean } : {}),
      };
    });
    unique(fields.map((f) => f.name));
    return { id: id(e.id), title: text(e.title), fields };
  });
  unique(entities.map((e) => e.id));
  const screens = list(o.screens, 10).map((value) => {
    const s = obj(value);
    if (!['list', 'form', 'dashboard'].includes(String(s.kind))) throw bad();
    const entityId = id(s.entityId);
    if (!entities.some((e) => e.id === entityId)) throw bad();
    return {
      id: id(s.id),
      title: text(s.title),
      kind: s.kind as MockScreen['kind'],
      entityId,
      nextScreenId: s.nextScreenId == null ? null : id(s.nextScreenId),
    };
  });
  unique(screens.map((s) => s.id));
  for (const s of screens)
    if (s.nextScreenId && !screens.some((x) => x.id === s.nextScreenId))
      throw bad();
  if (!Array.isArray(o.assumptions) || o.assumptions.length > 10) throw bad();
  return {
    title: text(o.title),
    description: text(description, 4000),
    fields: entities[0].fields.map((f) => f.name),
    template: 'generated',
    version: 2,
    entities,
    screens,
    assumptions: o.assumptions.map((x) => text(x, 300)),
    ...(o.workflows !== undefined
      ? { workflows: parseWorkflows(o.workflows, entities) }
      : {}),
  };
}
