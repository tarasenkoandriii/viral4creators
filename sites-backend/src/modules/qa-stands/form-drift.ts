import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
interface Field {
  id: string;
  type: string;
  required: boolean;
  options: string[];
  min: number | null;
  max: number | null;
  maxLength: number | null;
}
function invalid(): never {
  throw new BadRequestException(
    'Нужны два снимка структуры формы без значений, cookies и credentials.',
  );
}
function object(v: unknown, keys: string[]) {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    return invalid();
  return v as Record<string, unknown>;
}
function identifier(v: unknown) {
  if (typeof v !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(v))
    return invalid();
  return v;
}
function snapshot(v: unknown) {
  const o = object(v, ['url', 'version', 'fields']);
  let url: URL;
  try {
    url = new URL(String(o.url));
  } catch {
    return invalid();
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href.length > 300
  )
    return invalid();
  const version = identifier(o.version);
  if (!Array.isArray(o.fields) || !o.fields.length || o.fields.length > 50)
    return invalid();
  const fields: Field[] = o.fields
    .map((value) => {
      const f = object(value, [
        'id',
        'type',
        'required',
        'options',
        'min',
        'max',
        'maxLength',
      ]);
      const id = identifier(f.id);
      if (
        ![
          'text',
          'number',
          'email',
          'url',
          'select',
          'checkbox',
          'date',
          'datetime',
          'password',
          'file',
        ].includes(String(f.type)) ||
        typeof f.required !== 'boolean'
      )
        return invalid();
      if (
        f.options !== undefined &&
        (!Array.isArray(f.options) ||
          f.options.length > 30 ||
          f.options.some(
            (x) =>
              typeof x !== 'string' || !/^[\p{L}\p{N}_. -]{1,80}$/u.test(x),
          ))
      )
        return invalid();
      const options = [...new Set((f.options ?? []) as string[])].sort();
      for (const key of ['min', 'max', 'maxLength'])
        if (
          f[key] !== undefined &&
          (typeof f[key] !== 'number' ||
            !Number.isFinite(f[key]) ||
            Math.abs(f[key] as number) > 1e9)
        )
          return invalid();
      if (
        typeof f.maxLength === 'number' &&
        (!Number.isInteger(f.maxLength) || f.maxLength < 0)
      )
        return invalid();
      if (
        typeof f.min === 'number' &&
        typeof f.max === 'number' &&
        f.min > f.max
      )
        return invalid();
      return {
        id,
        type: String(f.type),
        required: f.required,
        options,
        min: (f.min ?? null) as number | null,
        max: (f.max ?? null) as number | null,
        maxLength: (f.maxLength ?? null) as number | null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(fields.map((f) => f.id)).size !== fields.length) return invalid();
  return { url: url.href, version, fields };
}
/** Pure structural comparison: never opens URLs, accepts field values or authorizes filling. */
export function compareForms(input: unknown) {
  const o = object(input, ['baseline', 'current']);
  const baseline = snapshot(o.baseline),
    current = snapshot(o.current);
  if (baseline.url !== current.url) return invalid();
  const changes: string[] = [];
  for (const f of baseline.fields) {
    const next = current.fields.find((x) => x.id === f.id);
    if (!next) changes.push(`removed:${f.id}`);
    else
      for (const key of [
        'type',
        'required',
        'options',
        'min',
        'max',
        'maxLength',
      ] as const)
        if (JSON.stringify(f[key]) !== JSON.stringify(next[key]))
          changes.push(`changed:${f.id}:${key}`);
  }
  for (const f of current.fields)
    if (!baseline.fields.some((x) => x.id === f.id))
      changes.push(`added:${f.id}`);
  const hash = (v: unknown) =>
    createHash('sha256').update(JSON.stringify(v)).digest('hex');
  return {
    blocked: changes.length > 0,
    changes,
    url: baseline.url,
    baselineVersion: baseline.version,
    currentVersion: current.version,
    baselineHash: hash(baseline.fields),
    currentHash: hash(current.fields),
  };
}
