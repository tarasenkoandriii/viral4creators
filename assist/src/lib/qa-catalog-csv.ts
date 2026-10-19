import { payload, type QaCasePayload } from './qa-catalog-api';
export interface CsvQaCase {
  caseKey: string;
  payload: QaCasePayload;
}
const columns = [
  'caseKey',
  'title',
  'purpose',
  'preconditions',
  'type',
  'priority',
  'tags',
  'requirementIds',
  'steps',
  'archived',
];
const fail = (): never => {
  throw new Error(
    'Нужен CSV UTF-8 с заголовком каталога QA, до 100 кейсов и 512 КиБ.'
  );
};
function safe(v: string) {
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}
function unsafed(v: string) {
  return /^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v;
}
export function exportQaCsv(rows: CsvQaCase[]): string {
  const cell = (s: string) => '"' + safe(s).replace(/"/g, '""') + '"';
  return (
    '\ufeff' +
    [
      columns,
      ...rows.map((r) => [
        r.caseKey,
        r.payload.title,
        r.payload.purpose,
        r.payload.preconditions,
        r.payload.type,
        r.payload.priority,
        JSON.stringify(r.payload.tags),
        JSON.stringify(r.payload.requirementIds),
        JSON.stringify(r.payload.steps),
        String(r.payload.archived),
      ]),
    ]
      .map((row) => row.map(cell).join(','))
      .join('\r\n') +
    '\r\n'
  );
}
export function parseQaCsv(input: string): CsvQaCase[] {
  if (new TextEncoder().encode(input).length > 512 * 1024) return fail();
  const text = input.replace(/^\ufeff/, ''),
    rows: string[][] = [];
  let row: string[] = [],
    value = '',
    quoted = false,
    closed = false;
  const push = () => {
    row.push(unsafed(value));
    value = '';
    closed = false;
  };
  const line = () => {
    push();
    if (row.some((c) => c.length)) rows.push(row);
    row = [];
    if (rows.length > 101) fail();
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else value += c;
      continue;
    }
    if (c === ',') {
      push();
      continue;
    }
    if (c === '\r' || c === '\n') {
      line();
      if (c === '\r' && text[i + 1] === '\n') i++;
      continue;
    }
    if (closed) return fail();
    if (c === '"') {
      if (value) return fail();
      quoted = true;
    } else value += c;
  }
  if (quoted) return fail();
  if (value || row.length || closed) line();
  if (
    !rows.length ||
    JSON.stringify(rows[0]) !== JSON.stringify(columns) ||
    rows.length < 2
  )
    return fail();
  const result = rows.slice(1).map((c) => {
    if (
      c.length !== columns.length ||
      !/^[A-Z][A-Z0-9-]{1,63}$/.test(c[0]) ||
      !['true', 'false'].includes(c[9])
    )
      return fail();
    let p: QaCasePayload;
    try {
      p = payload({
        title: c[1],
        purpose: c[2],
        preconditions: c[3],
        type: c[4],
        priority: c[5],
        tags: JSON.parse(c[6]),
        requirementIds: JSON.parse(c[7]),
        steps: JSON.parse(c[8]),
        archived: c[9] === 'true',
      });
    } catch {
      return fail();
    }
    return { caseKey: c[0], payload: p };
  });
  if (
    new Set(result.map((c) => c.caseKey)).size !== result.length ||
    new TextEncoder().encode(JSON.stringify({ cases: result })).length >
      512 * 1024
  )
    return fail();
  return result;
}
export function requirementLinks(rows: CsvQaCase[]) {
  const map = new Map<string, { manual: string[]; automated: string[] }>();
  for (const row of rows)
    for (const id of row.payload.requirementIds) {
      const group = map.get(id) ?? { manual: [], automated: [] };
      group[row.payload.type].push(row.caseKey);
      map.set(id, group);
    }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([requirement, cases]) => ({ requirement, ...cases }));
}
