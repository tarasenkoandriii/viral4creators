/**
 * Сжатие имён свойств в чанках (аудит C, `vite.mangle.ts`): esbuild
 * `mangleProps` на итоговом бандле `loader.js`, `act.js`, `admin-act.js`
 * переименовывает ВСЕ свойства с `_` и буквой. Безопасно, только пока такие
 * имена не выходят за чанк. Сверка по AST исходников (TypeScript):
 *  1. имена `_x` (свойства, поля, методы, ключи, деструктуризация) — только
 *     в файлах сжимаемых чанков (`act/exec.ts`, `act/index.ts`,
 *     `admin-act/index.ts`, `loader/`); протокол postMessage
 *     (`shared/protocol.ts`, `editor-protocol.ts`, `admin-protocol.ts`,
 *     `ui-plan.ts`) и чанки, которые читают объекты загрузчика/act
 *     (engage, ana, bf, comp, undo, chat, …), их не содержат;
 *  2. нигде нет обращения к `_x` по строке (`o['_x']`) — его esbuild не
 *     сжимает, и имя разошлось бы с сжатым;
 *  3. стыки чанков `ActHost`, `ActApi`, `ActNatives` (act/index.ts,
 *     exec.ts) — без `_x`; объект в `post(...)` (сообщение iframe) — без `_x`;
 *  4. сборки loader/act/admin-act подключают `minifyChunk`, остальные — нет;
 *     образец имён — `^_[A-Za-z]` (не `__proto__`, не `x_y`).
 * Собранные чанки (что сжатие прошло) сверяет `size-budget.mjs`.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { MANGLE_PROPS } from '../vite.mangle';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

/** Файлы, чьи имена `_x` живут только внутри сжимаемых чанков. */
export const MANGLED_FILES = [
  'act/exec.ts',
  'act/index.ts',
  'admin-act/index.ts',
  'loader/index.ts',
  'loader/ui.ts',
];
/** Сборки со сжатием имён. */
const MANGLED_CONFIGS = [
  'vite.loader.config.ts',
  'vite.act.config.ts',
  'vite.admin-act.config.ts',
];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(path.join(dir, e.name))
      : /\.tsx?$/.test(e.name)
        ? [path.join(dir, e.name)]
        : []
  );
}

const nameOf = (n: ts.Node | undefined): string | null =>
  n && (ts.isIdentifier(n) || ts.isPrivateIdentifier(n))
    ? n.text
    : n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
      ? n.text
      : null;

export interface Found {
  /** Имена свойств/членов (доступ, объявление, ключ, деструктуризация). */
  props: Array<{ name: string; line: number }>;
  /** Обращения по строке `o['x']`. */
  byString: Array<{ name: string; line: number }>;
  /** Члены интерфейсов по имени интерфейса. */
  ifaces: Map<string, string[]>;
  /** Ключи объектов-аргументов `….post({...})`. */
  posted: Array<{ name: string; line: number }>;
  /** Строки-значения (`const k = '_x'; o[k]` — обращение по имени-строке). */
  strings: Array<{ name: string; line: number }>;
}

export function scan(code: string, file = 'x.ts'): Found {
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const out: Found = {
    props: [],
    byString: [],
    ifaces: new Map(),
    posted: [],
    strings: [],
  };
  const line = (n: ts.Node) =>
    sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const add = (list: Found['props'], n: ts.Node | undefined) => {
    const name = nameOf(n);
    if (name !== null && n) list.push({ name, line: line(n) });
  };
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n)) add(out.props, n.name);
    else if (
      ts.isElementAccessExpression(n) &&
      ts.isStringLiteralLike(n.argumentExpression)
    ) {
      add(out.byString, n.argumentExpression);
      add(out.props, n.argumentExpression);
    } else if (
      ts.isPropertyAssignment(n) ||
      ts.isShorthandPropertyAssignment(n) ||
      ts.isPropertyDeclaration(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n) ||
      ts.isPropertySignature(n) ||
      ts.isMethodSignature(n)
    )
      add(out.props, n.name);
    else if (ts.isBindingElement(n) && n.propertyName)
      add(out.props, n.propertyName);
    else if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent))
      add(out.props, n.name);
    else if (
      ts.isParameter(n) &&
      ts.isConstructorDeclaration(n.parent) &&
      ts.getModifiers(n)?.length
    )
      add(out.props, n.name);
    if (
      ts.isStringLiteralLike(n) &&
      !(ts.isPropertyAssignment(n.parent) && n.parent.name === n) &&
      !ts.isImportDeclaration(n.parent)
    )
      add(out.strings, n);
    if (ts.isInterfaceDeclaration(n))
      out.ifaces.set(
        n.name.text,
        n.members.map((m) => nameOf(m.name) || '').filter(Boolean)
      );
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'post'
    )
      for (let a of n.arguments) {
        // `post({...} as never)` — тот же объект сообщения.
        while (
          ts.isAsExpression(a) ||
          ts.isParenthesizedExpression(a) ||
          ts.isSatisfiesExpression(a) ||
          ts.isTypeAssertionExpression(a)
        )
          a = a.expression;
        if (ts.isObjectLiteralExpression(a))
          for (const p of a.properties) add(out.posted, p.name);
      }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const isMangled = (name: string) => MANGLE_PROPS.test(name);

/** Нарушения правил 1–3 для набора файлов `{rel: code}`. */
export function violations(files: Record<string, string>): string[] {
  const bad: string[] = [];
  const scans = Object.entries(files).map(
    ([rel, code]) => [rel, scan(code, rel)] as const
  );
  // Имена `_x`, объявленные/читаемые в сжимаемых чанках.
  const own = new Set(
    scans
      .filter(([rel]) => MANGLED_FILES.includes(rel))
      .flatMap(([, f]) => f.props.map((p) => p.name))
      .filter(isMangled)
  );
  for (const [rel, f] of scans) {
    for (const p of f.strings)
      if (own.has(p.name))
        bad.push(`${rel}:${p.line}: строка «${p.name}» — имя по строке`);
    const inChunk = MANGLED_FILES.includes(rel);
    if (!inChunk)
      for (const p of f.props)
        if (isMangled(p.name))
          bad.push(`${rel}:${p.line}: имя «${p.name}» вне сжимаемых чанков`);
    for (const p of f.byString)
      if (isMangled(p.name))
        bad.push(`${rel}:${p.line}: обращение по строке к «${p.name}»`);
    for (const p of f.posted)
      if (isMangled(p.name))
        bad.push(`${rel}:${p.line}: «${p.name}» в сообщении post()`);
    for (const i of ['ActHost', 'ActApi', 'ActNatives', 'EngageHost'])
      for (const m of f.ifaces.get(i) || [])
        if (isMangled(m)) bad.push(`${rel}: стык ${i}.${m} — имя сжимается`);
  }
  return bad;
}

function main() {
  // Образец: `_x`, но не `__proto__`/`x_y`/`_`.
  assert.ok(MANGLE_PROPS.test('_halt') && MANGLE_PROPS.test('_X'));
  assert.ok(!MANGLE_PROPS.test('__proto__') && !MANGLE_PROPS.test('_'));
  assert.ok(!MANGLE_PROPS.test('plan_id') && !MANGLE_PROPS.test('planId'));

  const files: Record<string, string> = {};
  for (const abs of walk(SRC))
    files[path.relative(SRC, abs).split(path.sep).join('/')] = readFileSync(
      abs,
      'utf8'
    );
  for (const rel of MANGLED_FILES) assert.ok(files[rel], `нет файла ${rel}`);
  assert.deepEqual(violations(files), [], 'имена `_x` выходят за чанк');

  // Сжатие действительно задействовано: в чанках есть `_x`-члены классов.
  const own = scan(files['act/exec.ts']).props.map((p) => p.name);
  for (const n of ['_halt', '_refusal', '_host', '_plan'])
    assert.ok(own.includes(n), `act/exec.ts: ${n}`);
  assert.ok(
    scan(files['loader/index.ts'])
      .props.map((p) => p.name)
      .includes('_frameWin')
  );
  // Поля по имени-строке (`this[k]`) — без `_`.
  assert.ok(/'chkQ'/.test(files['loader/index.ts']));

  // Самопроверка сканера: каждое нарушение ловится.
  const probe = (rel: string, code: string) => violations({ [rel]: code });
  assert.equal(probe('shared/protocol.ts', 'const m = { _x: 1 };').length, 1);
  assert.equal(probe('undo/index.ts', 'h._mark(true);').length, 1);
  assert.equal(probe('engage/host.ts', 'const { _a } = o;').length, 1);
  assert.equal(
    probe('act/exec.ts', "this['_halt'] = true;").length,
    2,
    'строка в чанке (обращение и строка-имя)'
  );
  assert.equal(
    probe(
      'loader/index.ts',
      "class L { private _q = 1; f(k = '_q' as const) { return this[k]; } }"
    ).length,
    1,
    'имя по строке через переменную'
  );
  assert.equal(
    probe('act/index.ts', "host.post({ type: 'ui-x', _plan: p });").length,
    1,
    'сообщение iframe'
  );
  assert.equal(
    probe('act/index.ts', 'host.post({ type: "x", _p: 1 } as never);').length,
    1,
    'сообщение с приведением типа'
  );
  assert.equal(
    probe('act/index.ts', 'export interface ActHost { _min(): void }').length,
    1,
    'стык ActHost'
  );
  assert.deepEqual(
    probe('act/exec.ts', 'class R { private _a = 1; f() { return this._a; } }'),
    []
  );
  assert.deepEqual(
    probe('chat/ui-plan.ts', 'const f = (_m: number) => _m; const s = "_x";'),
    [],
    'параметры и строки-значения — не свойства'
  );

  // Сборки: сжатие — только у loader/act/admin-act.
  for (const f of readdirSync(ROOT).filter((x) =>
    /^vite\..+\.config\.ts$/.test(x)
  )) {
    const code = readFileSync(path.join(ROOT, f), 'utf8');
    assert.equal(
      /minifyChunk\(/.test(code),
      MANGLED_CONFIGS.includes(f),
      `${f}: minifyChunk ${MANGLED_CONFIGS.includes(f) ? 'нужен' : 'не нужен'}`
    );
  }
  console.log(
    'mangle: имена `_x` только внутри loader/act/admin-act, не в протоколе, стыках и строках — ok'
  );
}

main();
