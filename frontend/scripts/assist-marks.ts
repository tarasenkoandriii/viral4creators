/**
 * Обратная проверка разметки помощника (Ш6, хвост (12), Р-Ш6-11):
 * статический разбор исходников TMA компилятором TypeScript. Для
 * каждого обращения к «платной или опасной» функции (список — в
 * `guide-assist.test.ts`) находим JSX-элементы, чьи `onClick`/
 * `onSubmit`/`onChange`/… к нему ведут — напрямую, через локальный
 * обработчик (`const f = …`, `useCallback`, `function f`), через проп
 * дочернего компонента (`<Child onX={f}>` → `onX` внутри `Child`),
 * через член результата хука или функции (`useWorkflow().generateVideo`,
 * `copy.api.remove`) или через экспортированную обёртку из другого
 * модуля, — и читаем `data-assist` на элементе или его JSX-предке:
 * исполнитель «Админки» смотрит `closest()`, поэтому обёртка
 * `<div data-assist="confirm">` вокруг `<Pills>` на месте использования
 * — тоже пометка.
 *
 * Разбор консервативный: путь, который он не умеет проследить (вызов
 * при отрисовке, объект с обработчиками в аргументе, `useEffect`), — не
 * «всё хорошо», а отдельная находка (`loose`/`auto`), которую тест
 * требует либо разметить, либо внести в allowlist с обоснованием.
 * Находка по элементу (кнопке) allowlist'ом не снимается никогда — только
 * пометкой (аудит P2, 06.10.2026).
 *
 * Аудит P3 (06.10.2026) закрыл дыры разбора: кнопка без `type` в форме —
 * submit; `import * as X` и `X.fn`; `data-assist` с веткой `undefined`
 * или не-литералом — «не помечено»; обёртки, экспортированные через
 * `export { f }`/`export { f as g }`/`export default`; capture-события
 * исполнителя.
 */
import ts from 'typescript';

export type Tier = 'never' | 'confirm';

/** Модуль → функция → уровень. Пути — от корня `frontend`. */
export type PaidApis = Record<string, Record<string, Tier>>;

export interface ElementHit {
  file: string;
  line: number;
  /** `<Button onClick>` (+ «через <Child onX> файл:строка»). */
  where: string;
  /** Обработчик — событие, которое исполнитель «Админки» умеет вызвать. */
  executor: boolean;
  required: Tier;
  /** Что стоит на элементе/предке: `never`, `confirm` или null. */
  marked: Tier | null;
  apis: Set<string>;
  trails: Set<string>;
  lineText: string;
}

export interface LooseHit {
  kind: 'loose' | 'auto';
  file: string;
  line: number;
  api: string;
  why: string;
  trail: string;
  lineText: string;
}

export interface AssistMarksReport {
  elements: ElementHit[];
  loose: LooseHit[];
  /** Сколько обращений к списку найдено (шов не пуст). */
  seeds: number;
}

/** Компоненты UI-кита, которые отдают `data-assist` и `on*` DOM-элементу. */
const PRIMITIVES = new Set(['Button', 'Card', 'Input', 'Textarea', 'Select']);
const EFFECTS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect']);
const MEMOS = new Set(['useCallback', 'useMemo']);
const HOOKS_WITH_DEPS = new Set([...EFFECTS, ...MEMOS, 'useImperativeHandle']);

/**
 * События, которые вызывает исполнитель «Админки» (`widget/src/act/exec.ts`:
 * `click`/`check` — pointer- и mouse-последовательность и `click()`,
 * `fill`/`select` — `focus`, `input`, `change`; клик по submit-кнопке —
 * `submit` формы). Двойной клик, клавиатура, жесты, медиа-события ему
 * недоступны — такие обработчики в отчёте, но пометки не требуют.
 */
const EXECUTOR_EVENTS = new Set([
  'onClick',
  'onClickCapture',
  'onSubmit',
  'onChange',
  'onInput',
  'onFocus',
  'onBlur',
  'onPointerDown',
  'onPointerUp',
  'onPointerEnter',
  'onPointerOver',
  'onMouseDown',
  'onMouseUp',
  'onMouseEnter',
  'onMouseOver',
  // Capture-фаза тех же событий срабатывает раньше обычной — исполнитель
  // вызывает их той же последовательностью (аудит P3).
  'onPointerDownCapture',
  'onMouseDownCapture',
  'onSubmitCapture',
  'onChangeCapture',
  'onFocusCapture',
]);

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

interface Usage {
  file: string;
  el: Opening;
}

interface Ctx {
  api: string;
  tier: Tier;
  trail: string[];
  /** Места использования компонентов, через пропсы которых пришли. */
  via: Usage[];
}

interface Imp {
  local: string;
  /** Имя в модуле; `*` — `import * as local` (обращения `local.fn`). */
  imported: string;
  module: string;
}

/** Ссылка на экспорт другого модуля: идентификатор или `ns.fn`. */
interface ImportRef {
  file: string;
  node: ts.Expression;
  local: string;
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function isFunctionLike(n: ts.Node): n is ts.SignatureDeclaration {
  return (
    ts.isArrowFunction(n) ||
    ts.isFunctionExpression(n) ||
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n)
  );
}

function hasModifier(n: ts.Node, kind: ts.SyntaxKind): boolean {
  const mods = ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined;
  return !!mods?.some((m) => m.kind === kind);
}

/** Идентификатор — чтение значения (не имя свойства, не объявление, не тип). */
function isValueRef(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p)) &&
    p.name === id
  )
    return false;
  if (ts.isBindingElement(p)) return false;
  if (
    (ts.isVariableDeclaration(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isParameter(p) ||
      ts.isClassDeclaration(p)) &&
    p.name === id
  )
    return false;
  if (
    ts.isImportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p) ||
    ts.isExportSpecifier(p) ||
    ts.isJsxAttribute(p) ||
    ts.isJsxOpeningElement(p) ||
    ts.isJsxSelfClosingElement(p) ||
    ts.isJsxClosingElement(p) ||
    ts.isQualifiedName(p)
  )
    return false;
  for (let a: ts.Node | undefined = p; a; a = a.parent) {
    if (ts.isTypeNode(a)) return false;
    if (ts.isStatement(a) || ts.isSourceFile(a)) break;
  }
  return true;
}

function walk(n: ts.Node, fn: (n: ts.Node) => void): void {
  fn(n);
  n.forEachChild((c) => walk(c, fn));
}

function attrOf(el: Opening, name: string): ts.JsxAttribute | undefined {
  for (const a of el.attributes.properties)
    if (ts.isJsxAttribute(a) && a.name.getText() === name) return a;
  return undefined;
}

/**
 * Возможные значения выражения `data-assist`: литерал — сам уровень (или
 * `null` для иного текста), ветки `?:`/`&&`/`||`/`??` — объединение, всё
 * прочее (`undefined`, переменная, вызов) — `null`.
 */
function tiersOfExpr(
  e: ts.Expression | undefined,
  out: Set<Tier | null>
): void {
  if (!e) return void out.add(null);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    out.add(e.text === 'never' || e.text === 'confirm' ? e.text : null);
    return;
  }
  if (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e)
  )
    return tiersOfExpr(e.expression, out);
  if (ts.isConditionalExpression(e)) {
    tiersOfExpr(e.whenTrue, out);
    tiersOfExpr(e.whenFalse, out);
    return;
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      out.add(null); // ложная ветка — `false`/`0`/`''`, не пометка
      tiersOfExpr(e.right, out);
      return;
    }
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      tiersOfExpr(e.left, out);
      tiersOfExpr(e.right, out);
      return;
    }
  }
  out.add(null);
}

/**
 * Уровень по `data-assist` самого элемента. Выражение — слабейший из
 * возможных: обе ветки-литерала → `confirm`, если есть; ветка
 * `undefined`/не-литерал — `null` (аудит P3: раньше `x ? 'confirm' :
 * undefined` считался пометкой).
 */
function ownMark(el: Opening): Tier | null {
  const a = attrOf(el, 'data-assist');
  if (!a?.initializer) return null;
  const vals = new Set<Tier | null>();
  if (ts.isStringLiteral(a.initializer)) tiersOfExpr(a.initializer, vals);
  else if (ts.isJsxExpression(a.initializer))
    tiersOfExpr(a.initializer.expression, vals);
  else vals.add(null);
  if (vals.has(null) || vals.size === 0) return null;
  if (vals.has('confirm')) return 'confirm';
  return 'never';
}

/**
 * Уровень `ConfirmDialog` (`components/ui/ConfirmDialog.tsx`, шов ниже):
 * `danger` по умолчанию `true` → «никогда»; `danger={false}` →
 * «с подтверждением»; иное выражение — неизвестно, считаем слабейшим.
 */
function dialogTier(el: Opening): Tier {
  const d = attrOf(el, 'danger');
  if (!d || !d.initializer) return 'never';
  const e = ts.isJsxExpression(d.initializer)
    ? d.initializer.expression
    : undefined;
  return e?.kind === ts.SyntaxKind.TrueKeyword ? 'never' : 'confirm';
}

function stronger(a: Tier | null, b: Tier | null): Tier | null {
  if (a === 'never' || b === 'never') return 'never';
  return a ?? b;
}

/**
 * Пометка элемента с учётом JSX-предков в том же дереве (`closest()`):
 * «никогда» у любого предка — «никогда»; иначе `confirm`, если есть.
 * Элемент в `secondaryAction` диалога — уровень диалога. `skipSelf` —
 * для места использования компонента: его собственный атрибут
 * компонент может и не отдать DOM.
 */
function effectiveMark(el: Opening, skipSelf = false): Tier | null {
  let out: Tier | null = null;
  let cur: ts.Node = el;
  for (;;) {
    const opening: Opening | null =
      ts.isJsxOpeningElement(cur) || ts.isJsxSelfClosingElement(cur)
        ? cur
        : ts.isJsxElement(cur)
          ? cur.openingElement
          : null;
    if (opening && !(skipSelf && opening === el))
      out = stronger(out, ownMark(opening));
    const p: ts.Node | undefined = cur.parent;
    if (!p) break;
    if (ts.isJsxAttribute(p)) {
      const host = p.parent.parent;
      if (
        host.tagName.getText() === 'ConfirmDialog' &&
        p.name.getText() === 'secondaryAction'
      )
        out = stronger(out, dialogTier(host));
      break;
    }
    if (isFunctionLike(p) || ts.isSourceFile(p)) break;
    // Из открывающего тега — к его JsxElement, затем к родителям.
    cur = ts.isJsxOpeningElement(cur) ? cur.parent : p;
  }
  return out;
}

/** Литеральное значение атрибута (`"x"` или `{'x'}`); иначе `undefined`. */
function literalAttr(el: Opening, name: string): string | null | undefined {
  const a = attrOf(el, name);
  if (!a) return null; // атрибута нет
  const init = a.initializer;
  if (init && ts.isStringLiteral(init)) return init.text;
  if (
    init &&
    ts.isJsxExpression(init) &&
    init.expression &&
    (ts.isStringLiteral(init.expression) ||
      ts.isNoSubstitutionTemplateLiteral(init.expression))
  )
    return init.expression.text;
  return undefined; // выражение — значение неизвестно
}

/**
 * Элементы, отправляющие форму: `<button>`/`<Button>` — всё, кроме
 * `type="button"`/`"reset"` (без `type` кнопка в форме — submit, а
 * `Button` UI-кита своего `type` не ставит; аудит P3); `<input>`/`<Input>`
 * с `type="submit"|"image"`. Неизвестное выражение в `type` — считаем
 * submit (консервативно).
 */
function submitButtons(form: ts.JsxOpeningElement): Opening[] {
  const out: Opening[] = [];
  walk(form.parent, (n) => {
    if (!(ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n))) return;
    const tag = n.tagName.getText();
    const t = literalAttr(n, 'type');
    if (tag === 'button' || tag === 'Button') {
      if (t !== 'button' && t !== 'reset') out.push(n);
    } else if (tag === 'input' || tag === 'Input') {
      if (t === undefined || t === 'submit' || t === 'image') out.push(n);
    }
  });
  return out;
}

/** `a.b.c` оканчивается цепочкой `path` (`['b', 'c']`). */
function endsWithPath(n: ts.PropertyAccessExpression, path: string[]): boolean {
  let cur: ts.Expression = n;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    if (!ts.isPropertyAccessExpression(cur) || cur.name.text !== path[i])
      return false;
    cur = cur.expression;
  }
  return true;
}

export function analyzeAssistMarks(
  sources: Record<string, string>,
  paid: PaidApis
): AssistMarksReport {
  const files = new Map<string, ts.SourceFile>();
  for (const [path, text] of Object.entries(sources))
    files.set(
      path,
      ts.createSourceFile(
        path,
        text,
        ts.ScriptTarget.Latest,
        true,
        path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      )
    );

  const resolve = (from: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null;
    const dir = from.split('/').slice(0, -1).join('/');
    const base = normalize(`${dir}/${spec}`);
    for (const c of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
    ])
      if (files.has(c)) return c;
    return null;
  };

  const importsCache = new Map<string, Imp[]>();
  const importsOf = (file: string): Imp[] => {
    const hit = importsCache.get(file);
    if (hit) return hit;
    const out: Imp[] = [];
    for (const st of files.get(file)!.statements) {
      if (!ts.isImportDeclaration(st) || !st.importClause) continue;
      if (st.importClause.isTypeOnly) continue;
      const mod = resolve(file, (st.moduleSpecifier as ts.StringLiteral).text);
      if (!mod) continue;
      if (st.importClause.name)
        out.push({
          local: st.importClause.name.text,
          imported: 'default',
          module: mod,
        });
      const nb = st.importClause.namedBindings;
      if (nb && ts.isNamespaceImport(nb))
        out.push({ local: nb.name.text, imported: '*', module: mod });
      if (nb && ts.isNamedImports(nb))
        for (const s of nb.elements)
          if (!s.isTypeOnly)
            out.push({
              local: s.name.text,
              imported: (s.propertyName ?? s.name).text,
              module: mod,
            });
    }
    importsCache.set(file, out);
    return out;
  };

  const declares = (file: string, name: string): boolean => {
    for (const st of files.get(file)?.statements ?? []) {
      if (ts.isFunctionDeclaration(st) && st.name?.text === name) return true;
      if (ts.isVariableStatement(st))
        for (const d of st.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.name.text === name) return true;
    }
    return false;
  };

  /** Где на самом деле объявлен `name` модуля `file` (через реэкспорт). */
  const origin = (
    file: string,
    name: string,
    depth = 0
  ): { file: string; name: string } => {
    const sf = files.get(file);
    if (!sf || depth > 8 || declares(file, name)) return { file, name };
    for (const st of sf.statements) {
      if (!ts.isExportDeclaration(st) || !st.moduleSpecifier) continue;
      const mod = resolve(file, (st.moduleSpecifier as ts.StringLiteral).text);
      if (!mod) continue;
      if (!st.exportClause) {
        const o = origin(mod, name, depth + 1);
        if (declares(o.file, o.name)) return o;
      } else if (ts.isNamedExports(st.exportClause)) {
        for (const s of st.exportClause.elements)
          if (s.name.text === name)
            return origin(mod, (s.propertyName ?? s.name).text, depth + 1);
      }
    }
    return { file, name };
  };

  const originCache = new Map<string, { file: string; name: string }>();
  const originOf = (file: string, name: string) => {
    const k = `${file}|${name}`;
    let hit = originCache.get(k);
    if (!hit) {
      hit = origin(file, name);
      originCache.set(k, hit);
    }
    return hit;
  };

  const refsIn = (scope: ts.Node, name: string): ts.Identifier[] => {
    const out: ts.Identifier[] = [];
    walk(scope, (n) => {
      if (ts.isIdentifier(n) && n.text === name && isValueRef(n)) out.push(n);
    });
    return out;
  };

  /**
   * Обращения к `name` из `file` в других модулях: по именованному/
   * default-импорту — ссылки на локальное имя; по `import * as X` —
   * `X.name` (и `X.alias`, если `alias` в `file` реэкспортирует `name`).
   * Пространство имён, ушедшее целиком (`f(X)`, `X[k]`), — в `whole`.
   */
  const refsCache = new Map<string, ts.Identifier[]>();
  const refsOfLocal = (file: string, local: string): ts.Identifier[] => {
    const k = `${file}|${local}`;
    let hit = refsCache.get(k);
    if (!hit) {
      hit = refsIn(files.get(file)!, local);
      refsCache.set(k, hit);
    }
    return hit;
  };

  const importRefs = (
    file: string,
    name: string
  ): { refs: ImportRef[]; whole: ImportRef[] } => {
    const refs: ImportRef[] = [];
    const whole: ImportRef[] = [];
    for (const f of files.keys())
      for (const imp of importsOf(f)) {
        if (imp.imported !== '*') {
          const o = originOf(imp.module, imp.imported);
          if (o.file === file && o.name === name)
            for (const r of refsOfLocal(f, imp.local))
              refs.push({ file: f, node: r, local: imp.local });
          continue;
        }
        // `import * as X` модуля, который `name` не отдаёт, нас не касается.
        if (!exportsName(imp.module, file, name)) continue;
        for (const r of refsOfLocal(f, imp.local)) {
          const pa = r.parent;
          if (ts.isPropertyAccessExpression(pa) && pa.expression === r) {
            const o = originOf(imp.module, pa.name.text);
            if (o.file === file && o.name === name)
              refs.push({ file: f, node: pa, local: imp.local });
          } else whole.push({ file: f, node: r, local: imp.local });
        }
      }
    return { refs, whole };
  };

  /** Модуль `mod` (или его реэкспорт) отдаёт `name` из `file`. */
  const exportsName = (mod: string, file: string, name: string): boolean => {
    if (mod === file) return true;
    const sf = files.get(mod);
    if (!sf) return false;
    for (const st of sf.statements) {
      if (!ts.isExportDeclaration(st) || !st.moduleSpecifier) continue;
      if (!st.exportClause) {
        const sub = resolve(mod, (st.moduleSpecifier as ts.StringLiteral).text);
        if (sub) {
          const o = originOf(sub, name);
          if (o.file === file && o.name === name) return true;
        }
      } else if (ts.isNamedExports(st.exportClause)) {
        for (const s of st.exportClause.elements) {
          const o = originOf(mod, s.name.text);
          if (o.file === file && o.name === name) return true;
        }
      }
    }
    return false;
  };

  /** Файлы-потребители экспорта `name` из `file` (любым видом импорта). */
  const importersOf = (file: string, name: string): string[] => [
    ...new Set(importRefs(file, name).refs.map((r) => r.file)),
  ];

  /**
   * Под какими именами модуль `file` экспортирует локальное `name`:
   * `export function/const name` → `name`, `export default function
   * name` → `default`, `export { name }`/`export { name as alias }` →
   * `name`/`alias` (аудит P3: раньше видели только модификатор `export`).
   * `export default name;` разбирает `valueAt` (ссылка в ExportAssignment).
   */
  const exportNamesOf = (
    file: string,
    name: string,
    decl: ts.Node
  ): string[] => {
    const out: string[] = [];
    const holder = ts.isVariableDeclaration(decl) ? decl.parent.parent : decl;
    if (hasModifier(holder, ts.SyntaxKind.ExportKeyword))
      out.push(
        hasModifier(holder, ts.SyntaxKind.DefaultKeyword) ? 'default' : name
      );
    for (const st of files.get(file)?.statements ?? [])
      if (
        ts.isExportDeclaration(st) &&
        !st.moduleSpecifier &&
        !st.isTypeOnly &&
        st.exportClause &&
        ts.isNamedExports(st.exportClause)
      )
        for (const s of st.exportClause.elements)
          if ((s.propertyName ?? s.name).text === name) out.push(s.name.text);
    return out;
  };

  const lineOf = (file: string, node: ts.Node) => {
    const sf = files.get(file)!;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    return { line: line + 1, text: sf.text.split('\n')[line]?.trim() ?? '' };
  };

  const elements = new Map<string, ElementHit>();
  const loose: LooseHit[] = [];
  const seen = new Set<string>();
  let seeds = 0;

  const viaKey = (ctx: Ctx) =>
    ctx.via.map((u) => `${u.file}@${u.el.pos}`).join('>');

  const once = (key: string, ctx: Ctx): boolean => {
    const k = `${ctx.api}|${viaKey(ctx)}|${key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };

  const fail = (
    kind: 'loose' | 'auto',
    file: string,
    node: ts.Node,
    ctx: Ctx,
    why: string
  ) => {
    const { line, text } = lineOf(file, node);
    loose.push({
      kind,
      file,
      line,
      api: ctx.api,
      why,
      trail: ctx.trail.join(' ← '),
      lineText: text,
    });
  };

  const step = (ctx: Ctx, s: string): Ctx => ({
    ...ctx,
    trail: [...ctx.trail, s],
  });

  const scopeOf = (decl: ts.Node): ts.Node => {
    let scope: ts.Node = decl.parent;
    while (
      !ts.isBlock(scope) &&
      !ts.isSourceFile(scope) &&
      !isFunctionLike(scope) &&
      scope.parent
    )
      scope = scope.parent;
    return scope;
  };

  // ── узлы обхода ────────────────────────────────────────────────────

  /** `node` — выражение, чьё значение опасно (функция или ссылка на неё). */
  const valueAt = (file: string, node: ts.Node, ctx: Ctx): void => {
    let cur: ts.Node = node;
    let p: ts.Node = cur.parent;
    while (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isTypeAssertionExpression(p) ||
      (ts.isConditionalExpression(p) && p.condition !== cur) ||
      (ts.isBinaryExpression(p) &&
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(p.operatorToken.kind))
    ) {
      cur = p;
      p = p.parent;
    }
    if (ts.isFunctionDeclaration(cur)) {
      if (cur.name) return named(file, cur.name.text, cur, ctx);
      if (hasModifier(cur, ts.SyntaxKind.DefaultKeyword))
        return consumers(file, 'default', step(ctx, 'export default'));
      return fail('loose', file, cur, ctx, 'безымянная функция');
    }
    // `export default f;` / `export default () => …` — потребители default.
    if (ts.isExportAssignment(p) && !p.isExportEquals)
      return consumers(file, 'default', step(ctx, 'export default'));
    if (ts.isMethodDeclaration(cur))
      return fail('loose', file, cur, ctx, 'метод класса');
    if (ts.isVariableDeclaration(p) && p.initializer === cur) {
      if (ts.isIdentifier(p.name)) return named(file, p.name.text, p, ctx);
      return fail('loose', file, p, ctx, 'деструктуризация опасного значения');
    }
    if (ts.isCallExpression(p)) {
      if (p.expression === cur) return inside(file, p, ctx);
      const callee = calleeName(p);
      if (callee && MEMOS.has(callee)) return valueAt(file, p, ctx);
      if (callee && EFFECTS.has(callee))
        return fail('auto', file, p, ctx, `вызов из ${callee}`);
      return inside(file, p, ctx);
    }
    if (ts.isArrayLiteralExpression(p)) {
      const call = p.parent;
      if (
        ts.isCallExpression(call) &&
        call.arguments[1] === p &&
        HOOKS_WITH_DEPS.has(calleeName(call) ?? '')
      )
        return; // массив зависимостей хука — не вызов
      return inside(file, p, ctx);
    }
    if (ts.isJsxExpression(p)) {
      if (ts.isJsxAttribute(p.parent)) return element(file, p.parent, ctx);
      return fail('loose', file, p, ctx, 'вызов при отрисовке JSX');
    }
    if (ts.isPropertyAssignment(p) && p.initializer === cur)
      return property(file, [p.name.getText()], p.parent, ctx);
    if (ts.isShorthandPropertyAssignment(p))
      return property(file, [p.name.text], p.parent, ctx);
    if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === cur)) {
      for (let a: ts.Node | undefined = p; a; a = a.parent)
        if (isFunctionLike(a) && a !== cur) return valueAt(file, a, ctx);
      return fail('loose', file, p, ctx, 'возврат вне функции');
    }
    return inside(file, p, ctx);
  };

  /** Опасное исполняется внутри `node` — ищем, кто его запускает. */
  const inside = (file: string, node: ts.Node, ctx: Ctx): void => {
    for (let p: ts.Node | undefined = node; p; p = p.parent) {
      if (ts.isJsxAttribute(p)) return element(file, p, ctx);
      if (p !== node && isFunctionLike(p)) return valueAt(file, p, ctx);
      if (ts.isSourceFile(p))
        return fail('loose', file, node, ctx, 'вызов на уровне модуля');
    }
  };

  /** Обработчик с именем `name` — все его упоминания в области видимости. */
  const named = (file: string, name: string, decl: ts.Node, ctx: Ctx): void => {
    if (!once(`n|${file}|${decl.pos}|${name}`, ctx)) return;
    if (/^[A-Z]/.test(name) && file.endsWith('.tsx'))
      return fail('loose', file, decl, ctx, `вызов при отрисовке ${name}`);
    if (/^use[A-Z]/.test(name))
      return fail('loose', file, decl, ctx, `вызов в теле хука ${name}`);
    const next = step(ctx, name);
    const scope = scopeOf(decl);
    for (const r of refsIn(scope, name)) valueAt(file, r, next);
    // Экспорт верхнего уровня — потребители в других модулях.
    if (ts.isSourceFile(scope))
      for (const exp of exportNamesOf(file, name, decl))
        consumers(file, exp, next);
  };

  /** Потребители экспорта `exp` модуля `file` — каждый как опасное значение. */
  const consumers = (file: string, exp: string, ctx: Ctx): void => {
    if (!once(`x|${file}|${exp}`, ctx)) return;
    const { refs, whole } = importRefs(file, exp);
    for (const r of refs) valueAt(r.file, r.node, step(ctx, r.file));
    for (const w of whole)
      fail(
        'loose',
        w.file,
        w.node,
        ctx,
        `пространство имён ${w.local} уходит целиком`
      );
  };

  /** Опасное значение лежит в объектном литерале по пути `path`. */
  const property = (
    file: string,
    path: string[],
    obj: ts.Node,
    ctx: Ctx
  ): void => {
    let cur = obj;
    let p = cur.parent;
    while (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p)
    ) {
      cur = p;
      p = p.parent;
    }
    // Вложенный объект: `{ api: { remove: f } }` → путь `api.remove`.
    if (ts.isPropertyAssignment(p) && p.initializer === cur)
      return property(file, [p.name.getText(), ...path], p.parent, ctx);
    if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === cur)) {
      let fn: ts.Node | undefined = p;
      while (fn && !(isFunctionLike(fn) && fn !== cur)) fn = fn.parent;
      // `useCallback(() => ({…}))`/`useMemo` — имя у переменной снаружи.
      let holder: ts.Node | undefined = fn?.parent;
      if (
        holder &&
        ts.isCallExpression(holder) &&
        MEMOS.has(calleeName(holder) ?? '')
      )
        holder = holder.parent;
      let fnName: string | null = null;
      if (fn && ts.isFunctionDeclaration(fn)) fnName = fn.name?.text ?? null;
      else if (holder && ts.isVariableDeclaration(holder))
        fnName = holder.name.getText();
      if (fnName) return resultMember(file, fnName, path, ctx);
    }
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
      const holder = p.name.text;
      for (const r of refsIn(scopeOf(p), holder)) {
        let top: ts.Node = r;
        for (const key of path) {
          const pa = top.parent;
          if (!ts.isPropertyAccessExpression(pa) || pa.name.text !== key) {
            top = r;
            break;
          }
          top = pa;
        }
        if (top !== r)
          valueAt(file, top, step(ctx, [holder, ...path].join('.')));
        else if (!ts.isPropertyAccessExpression(r.parent))
          fail('loose', file, r, ctx, `объект ${holder} уходит целиком`);
      }
      return;
    }
    fail(
      'loose',
      file,
      obj,
      ctx,
      `обработчик ${path.join('.')} в объектном литерале`
    );
  };

  /** `path` результата функции/хука `fnName` у его потребителей. */
  const resultMember = (
    file: string,
    fnName: string,
    path: string[],
    ctx: Ctx
  ): void => {
    if (!once(`m|${file}|${fnName}|${path.join('.')}`, ctx)) return;
    const next = step(ctx, `${fnName}().${path.join('.')}`);
    const users = new Set([file, ...importersOf(file, fnName)]);
    for (const c of users)
      walk(files.get(c)!, (n) => {
        if (ts.isPropertyAccessExpression(n) && endsWithPath(n, path))
          valueAt(c, n, next);
        else if (
          path.length === 1 &&
          ts.isBindingElement(n) &&
          ts.isObjectBindingPattern(n.parent) &&
          (n.propertyName ?? n.name).getText() === path[0] &&
          ts.isIdentifier(n.name)
        )
          named(c, n.name.text, n, next);
      });
  };

  const record = (
    file: string,
    el: Opening,
    name: string,
    ctx: Ctx,
    own: Tier | null
  ): void => {
    const { line, text } = lineOf(file, el);
    let marked = own;
    for (const u of ctx.via)
      marked = stronger(marked, effectiveMark(u.el, true));
    const via = ctx.via
      .map((u) => {
        const at = lineOf(u.file, u.el);
        return ` через <${u.el.tagName.getText()}> ${u.file}:${at.line}`;
      })
      .join('');
    const key = `${file}|${el.pos}|${name}|${viaKey(ctx)}`;
    const hit = elements.get(key) ?? {
      file,
      line,
      where: `<${el.tagName.getText()} ${name}>${via}`,
      executor:
        EXECUTOR_EVENTS.has(name) ||
        (el.tagName.getText() === 'ConfirmDialog' && name === 'onConfirm'),
      required: ctx.tier,
      marked,
      apis: new Set<string>(),
      trails: new Set<string>(),
      lineText: text,
    };
    if (ctx.tier === 'never') hit.required = 'never';
    hit.apis.add(ctx.api);
    hit.trails.add(ctx.trail.join(' ← '));
    elements.set(key, hit);
  };

  /** Опасное — в атрибуте `attr` JSX-элемента. */
  const element = (file: string, attr: ts.JsxAttribute, ctx: Ctx): void => {
    const el = attr.parent.parent;
    const tag = el.tagName.getText();
    const name = attr.name.getText();
    if (/^[a-z]/.test(tag) || PRIMITIVES.has(tag) || tag === 'ConfirmDialog') {
      if (!/^on[A-Z]/.test(name))
        return fail('loose', file, attr, ctx, `атрибут ${name} у <${tag}>`);
      let marked: Tier | null;
      if (tag === 'ConfirmDialog')
        marked = name === 'onConfirm' ? dialogTier(el) : effectiveMark(el);
      else {
        marked = effectiveMark(el);
        if (!marked && tag === 'form' && ts.isJsxOpeningElement(el)) {
          const subs = submitButtons(el).map((b) => effectiveMark(b));
          if (subs.length && subs.every((t) => t))
            marked = subs.includes('confirm') ? 'confirm' : 'never';
        }
      }
      return record(file, el, name, ctx, marked);
    }
    if (tag.includes('.'))
      return fail('loose', file, attr, ctx, `составной компонент <${tag}>`);
    const imp = importsOf(file).find((i) => i.local === tag);
    const target = imp ? origin(imp.module, imp.imported) : { file, name: tag };
    if (!files.has(target.file))
      return fail('loose', file, attr, ctx, `компонент <${tag}> вне src`);
    const next: Ctx = {
      ...step(ctx, `<${tag} ${name}>`),
      via: [...ctx.via, { file, el }],
    };
    childProp(target.file, target.name, name, next, attr, file);
  };

  /** Проп `prop` внутри компонента `comp` модуля `file`. */
  const childProp = (
    file: string,
    comp: string,
    prop: string,
    ctx: Ctx,
    at: ts.Node,
    atFile: string
  ): void => {
    if (!once(`p|${file}|${comp}|${prop}`, ctx)) return;
    let fn: ts.SignatureDeclaration | null = null;
    walk(files.get(file)!, (n) => {
      if (fn) return;
      if (ts.isFunctionDeclaration(n)) {
        if (
          n.name?.text === comp ||
          (comp === 'default' && hasModifier(n, ts.SyntaxKind.DefaultKeyword))
        )
          fn = n;
      } else if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === comp &&
        n.initializer
      ) {
        let init: ts.Node = n.initializer;
        // memo(…)/forwardRef(…)
        while (ts.isCallExpression(init) && init.arguments[0])
          init = init.arguments[0];
        if (isFunctionLike(init)) fn = init;
      }
    });
    const f = fn as ts.SignatureDeclaration | null;
    const param = f?.parameters[0];
    if (!f || !param)
      return fail('loose', atFile, at, ctx, `компонент ${comp} не найден`);
    let found = false;
    const viaSpread = (rest: string) =>
      walk(f, (n) => {
        if (
          ts.isJsxSpreadAttribute(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === rest
        ) {
          found = true;
          spread(file, n, prop, ctx);
        } else if (
          ts.isPropertyAccessExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === rest &&
          n.name.text === prop
        ) {
          found = true;
          valueAt(file, n, ctx);
        }
      });
    if (ts.isObjectBindingPattern(param.name)) {
      for (const b of param.name.elements) {
        if (!ts.isIdentifier(b.name)) continue;
        if (b.dotDotDotToken) viaSpread(b.name.text);
        else if ((b.propertyName ?? b.name).getText() === prop) {
          found = true;
          named(file, b.name.text, b, ctx);
        }
      }
    } else if (ts.isIdentifier(param.name)) viaSpread(param.name.text);
    if (!found)
      fail('loose', atFile, at, ctx, `проп ${prop} не прослежен в ${comp}`);
  };

  /**
   * Проп пришёл спредом `{...rest}` на элемент обёртки: `data-assist`
   * с места использования уходит тем же спредом — он считается.
   */
  const spread = (
    file: string,
    sp: ts.JsxSpreadAttribute,
    prop: string,
    ctx: Ctx
  ): void => {
    const el = sp.parent.parent;
    const tag = el.tagName.getText();
    if (!(/^[a-z]/.test(tag) || PRIMITIVES.has(tag)))
      return fail('loose', file, sp, ctx, `спред на <${tag}>`);
    const usage = ctx.via[ctx.via.length - 1];
    const own = stronger(effectiveMark(el), usage ? ownMark(usage.el) : null);
    record(file, el, prop, ctx, own);
  };

  // ── посев: обращения к функциям из списка ──────────────────────────
  for (const [mod, fns] of Object.entries(paid))
    for (const [name, tier] of Object.entries(fns)) {
      const ctx: Ctx = { api: name, tier, trail: [name], via: [] };
      const { refs, whole } = importRefs(mod, name);
      for (const r of refs) {
        if (paid[r.file]) continue; // сами API-модули не разбираем
        seeds += 1;
        valueAt(r.file, r.node, ctx);
      }
      for (const w of whole)
        if (!paid[w.file])
          fail(
            'loose',
            w.file,
            w.node,
            ctx,
            `пространство имён ${w.local} уходит целиком`
          );
    }

  return { elements: [...elements.values()], loose, seeds };
}
