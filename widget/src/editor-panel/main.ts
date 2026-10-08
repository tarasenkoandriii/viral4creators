/**
 * Панель редактора голосовой карты в iframe на ОТДЕЛЬНОМ origin `we.`
 * (Э6-тер, ТЗ §5-кватер.3, §5-кватер.6, §5-кватер.12; В-51) —
 * `/v1/editor-panel.js`. Ванильный TS без HTML-приёмников (CSP iframe:
 * `require-trusted-types-for 'script'; trusted-types 'none'`).
 *
 *  - токен ссылки — из фрагмента адреса (`#t=…`), фрагмент сразу снимается;
 *    обмен → сессия редактора (только память и `sessionStorage` этого origin:
 *    страница заказчика и публичный чат `w.` её не видят); после перехода
 *    по сайту (MPA) панель продолжает по сессии из `sessionStorage`;
 *  - сообщения пикера — только от `window.parent` с origin, на который
 *    выдана ссылка; всё от пикера — НЕДОВЕРЕННЫЕ данные: черновик меняет
 *    ТОЛЬКО клик человека здесь (`isTrusted` в нашем origin), публикация —
 *    только запрос, подтверждение — в Telegram (В-50);
 *  - вкладки: Цель (карточка), Страница (цели и образцы устойчивости),
 *    Мемо (запись кликами, перепривязка, «Прогнать» — `memo.ts`, Э6-тер (д)),
 *    Проверка («Сказать сейчас» — показ без нажатий), Публикация;
 *  - отмена — стек обратных операций сессии (с `expectedRevision`);
 *  - заход 9: массовые операции (`Shift`+клик / рамка в пикере → «Вибрано
 *    N»: в карту, заборонити, посилити ризик, контрольні, до шаблону),
 *    поиск цели (`/`), микрофон «Сказать сейчас» (`POST /editor/v1/voice`,
 *    кнопка 🎤 или `S` удерживать); новый шаблон — сначала шаблон (id
 *    выдаёт сервер), затем цели на его id.
 */
import './editor-panel.css';
import { EDITOR_SESSION_HEADER } from '../shared/brand';
import {
  editorEnvelope,
  parseToPanel,
  type Descriptor,
  type PageTarget,
  type Stability,
  type ToPanel,
  type ToPicker,
} from '../shared/editor-protocol';
import { T, fmt, type PanelLang } from './i18n';
import { createMemo } from './memo';

type Risk = 'now' | 'confirm' | 'never';

interface Target {
  key: string;
  scope: 'page' | 'template' | 'site';
  templateId: string | null;
  pagePath: string | null;
  descriptor: Descriptor;
  stability: Stability;
  names: Partial<Record<PanelLang, string>>;
  synonyms: Partial<Record<PanelLang, Array<{ text: string; origin: string }>>>;
  semanticType: string | null;
  riskComputed: Risk;
  riskOwner: Risk | null;
  denylisted: boolean;
  control: boolean;
  undo: { assistId: string; at: string | null } | null;
  status: 'active' | 'removed';
}

interface Template {
  id: string;
  name: string;
  pathPattern: string;
  samplePages: string[];
  status: string;
}

interface MapView {
  revision: number;
  publishedVersion: number;
  path: string;
  template: Template | null;
  templates: Template[];
  targets: Target[];
  keys: string[];
  gates: { ok: boolean; problems: Array<{ code: string; key?: string }> };
}

interface Picked {
  descriptor: Descriptor;
  how: string;
  stability: Stability;
  never: boolean;
}

interface TryView {
  heard: string;
  via: 'map' | 'direct' | 'model_needed' | 'none';
  key: string | null;
  phrase: string | null;
  steps: Array<{
    i: number;
    kind: string;
    risk: string;
    target: { ref: string; text: string } | null;
  }>;
  notes: Array<{ code: string; target: string | null }>;
  left: number;
}

const TYPES = [
  'nav',
  'search',
  'filter',
  'sort',
  'quantity',
  'option',
  'add-to-cart',
  'favorite',
  'compare',
  'open',
  'close',
  'form-field',
  'submit',
  'other',
];
const RANK: Record<Risk, number> = { now: 0, confirm: 1, never: 2 };
const KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const params = new URLSearchParams(location.search);
const PK = params.get('pk') || '';
const STORE = `v4c_ed:${PK}`;

const S = {
  lang: 'uk' as PanelLang,
  session: '',
  parentOrigin: '',
  path: '/',
  map: null as MapView | null,
  picked: null as Picked | null,
  edit: null as Target | null,
  tab: 'target' as 'target' | 'page' | 'memo' | 'try' | 'publish',
  note: '',
  fatal: '',
  undo: [] as Array<{ label: string; ops: unknown[] }>,
  tryRes: null as TryView | null,
  wrongFor: null as string | null,
  /** «Не то → выбрать»: синоним ждёт клика человека здесь. */
  pendingSyn: null as { key: string | null; phrase: string } | null,
  pendingLoad: false,
  /** Цель, открытая по ссылке из TMA (находка Т-3/Т-4, §5-кватер.10). */
  focusKey: null as string | null,
  counts: null as {
    green: number;
    yellow: number;
    red: number;
    violet: number;
  } | null,
  samples: new Map<string, number>(),
  /** Массовый выбор (Shift+клик, рамка) — дескрипторы пикера. */
  multi: [] as Descriptor[],
  q: '',
  /** Последняя команда «Сказать сейчас» (поле переживает перерисовку). */
  say: '',
  mic: null as MediaRecorder | null,
  reqId: 0,
  waiting: new Map<number, (m: ToPanel) => void>(),
};

const L = () => T[S.lang];

// ── DOM без HTML-приёмников ──
function h(
  tag: string,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...kids: Array<Node | string | null | false>
): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') e.addEventListener(k, v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false) e.setAttribute(k, v);
  }
  for (const c of kids) if (c !== null && c !== false) e.append(c);
  return e;
}

/** Только клик человека в нашем origin меняет черновик (§5-кватер.3). */
const human =
  (fn: () => void) =>
  (e: Event): void => {
    if (!e.isTrusted) return;
    fn();
  };

function toPicker(m: ToPicker): void {
  if (S.parentOrigin)
    window.parent.postMessage(editorEnvelope(m), S.parentOrigin);
}

function ask(m: ToPicker & { id: number }): Promise<ToPanel> {
  return new Promise((resolve) => {
    S.waiting.set(m.id, resolve);
    toPicker(m);
    setTimeout(() => {
      if (S.waiting.delete(m.id)) resolve({ type: 'route', path: S.path });
    }, 4000);
  });
}

async function api<T>(
  path: string,
  init: RequestInit = {},
  type = 'application/json'
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': type };
  if (S.session) headers[EDITOR_SESSION_HEADER] = S.session;
  const r = await fetch(path, { ...init, headers, credentials: 'omit' });
  let body: {
    success?: boolean;
    data?: T;
    error?: {
      code?: string;
      message?: string;
      details?: { errors?: Array<{ code: string }> };
    };
  } = {};
  try {
    body = await r.json();
  } catch {
    body = {};
  }
  if (r.ok && body.success !== false)
    return (body.data ?? (body as unknown)) as T;
  const code =
    body.error?.details &&
    (body.error as { details: { code?: string } }).details.code;
  const err = new Error(body.error?.message || `HTTP ${r.status}`) as Error & {
    status: number;
    code: string;
    errors: Array<{ code: string }>;
  };
  err.status = r.status;
  err.code = code || body.error?.code || '';
  err.errors = body.error?.details?.errors ?? [];
  throw err;
}

const memo = createMemo({
  h,
  human,
  api,
  toPicker,
  snapshot: async () => {
    const r = await ask({ type: 'snapshot-req', id: ++S.reqId });
    return r.type === 'snapshot' ? r.snapshot : null;
  },
  L,
  lang: () => S.lang,
  path: () => S.path,
  note: (n) => {
    S.note = n;
  },
  fail,
  render,
  store: STORE,
  edit: (key) => {
    const t = S.map?.targets.find((x) => x.key === key);
    if (!t) {
      S.note = fmt(L().miss, { k: key });
      return render();
    }
    open(t);
  },
});

/** Открыть карточку цели карты (список страницы, «↶» шага мемо). */
function open(t: Target): void {
  S.picked = {
    descriptor: t.descriptor,
    how: 'map',
    stability: t.stability,
    never: effective(t) === 'never',
  };
  S.edit = t;
  S.tab = 'target';
  toPicker({ type: 'focus', key: t.key });
  render();
}

/**
 * Шаблон по маске: существующий или новый ОТДЕЛЬНОЙ операцией — id нового
 * шаблона выдаёт сервер, цели ссылаются на него (в одном пакете цель на
 * id клиента не проходит разбор).
 */
async function templateId(mask: string): Promise<string | null> {
  const find = () =>
    S.map?.templates.find(
      (x) => x.pathPattern === mask && x.status === 'active'
    )?.id ?? null;
  if (find()) return find();
  const ok = await ops(
    [
      {
        op: 'upsert-template',
        template: { name: mask, pathPattern: mask, samplePages: [S.path] },
      },
    ],
    null,
    mask
  );
  return ok ? find() : null;
}

function colorOf(t: Target): PageTarget['color'] {
  const eff = effective(t);
  if (t.denylisted || eff === 'never') return 'violet';
  return t.stability === 'strong' ? 'green' : 'yellow';
}

function effective(t: Target): Risk {
  let r = t.riskComputed;
  if (t.riskOwner && RANK[t.riskOwner] > RANK[r]) r = t.riskOwner;
  if (t.semanticType === 'submit' && RANK[r] < 1) r = 'confirm';
  return r;
}

async function loadMap(): Promise<void> {
  try {
    S.map = await api<MapView>(
      `/editor/v1/map?path=${encodeURIComponent(S.path)}`
    );
    toPicker({
      type: 'targets',
      items: S.map.targets
        .filter((t) => t.status === 'active')
        .map((t) => ({
          key: t.key,
          descriptor: t.descriptor,
          color: colorOf(t),
        })),
    });
    // «Открыть в редакторе» мемо `memo-<N>-<шаг с 1>` (сигнал needs_review).
    const fm = /^memo-(\d{1,6})(?:-(\d{1,2}))?$/.exec(S.focusKey ?? '');
    if (fm) {
      S.focusKey = null;
      S.tab = 'memo';
      void memo.open(+fm[1], fm[2] ? +fm[2] - 1 : null);
    }
    // «Открыть в редакторе» из TMA: подсветить место цели и открыть карточку.
    const f = S.focusKey
      ? S.map.targets.find((t) => t.key === S.focusKey)
      : null;
    if (f) {
      S.focusKey = null;
      open(f);
    }
  } catch (e) {
    fail(e);
  }
  render();
}

function fail(e: unknown): void {
  const err = e as {
    status?: number;
    code?: string;
    errors?: Array<{ code: string }>;
    message?: string;
  };
  if (err.status === 401) {
    S.fatal = L().expired;
    try {
      sessionStorage.removeItem(STORE);
      sessionStorage.removeItem(`${STORE}:m`);
    } catch {
      /* — */
    }
  } else if (err.status === 409 && err.code === 'VOICE_MAP_CONFLICT') {
    S.note = L().conflict;
    void loadMap();
  } else if (err.code === 'VOICE_MAP_INVALID') {
    const map: Record<string, string> = {
      risk_lowering_forbidden: L().riskLowering,
      never_target_named: L().neverNamed,
      never_attr_denylist_only: L().neverAttr,
      text_invalid: L().textInvalid,
    };
    const why = (err.errors ?? []).map((x) => map[x.code] || x.code);
    S.note = fmt(L().invalid, {
      e: [...new Set(why)].join('; ') || err.message || '',
    });
  } else S.note = err.message || String(e);
  render();
}

/** Пакет операций: черновик + обратные операции для «Отменить». */
async function ops(
  list: unknown[],
  inverse: unknown[] | null,
  label: string
): Promise<boolean> {
  if (!S.map) return false;
  try {
    const r = await api<{ revision: number }>('/editor/v1/ops', {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: S.map.revision, ops: list }),
    });
    if (inverse) S.undo.push({ label, ops: inverse });
    S.note = fmt(L().saved, { n: r.revision });
    await loadMap();
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

// ── «транслит» ключа из видимого текста ──
const TR_SRC = 'абвгґдеєёжзиіїйклмнопрстуфхцчшщьъыэюя';
const TR_DST =
  'a b v h g d e ye e zh z y i yi y k l m n o p r s t u f kh ts ch sh shch _ _ y e yu ya'.split(
    ' '
  );
const TR: Record<string, string> = {};
[...TR_SRC].forEach((c, i) => (TR[c] = TR_DST[i].replace('_', '')));
function suggestKey(p: Picked): string {
  if (p.descriptor.assistId && KEY_RE.test(p.descriptor.assistId))
    return p.descriptor.assistId;
  const base = [...(p.descriptor.text || p.descriptor.tag).toLowerCase()]
    .map((c) => TR[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 34)
    .replace(/-+$/g, '');
  let k = KEY_RE.test(base) ? base : 'target';
  const taken = new Set(S.map?.keys ?? []);
  for (let i = 2; taken.has(k); i++) k = `${base || 'target'}-${i}`;
  return k;
}

function targetFor(d: Descriptor): Target | null {
  const list = S.map?.targets ?? [];
  return (
    list.find(
      (t) =>
        (d.assistId && t.descriptor.assistId === d.assistId) ||
        (!d.assistId &&
          !t.descriptor.assistId &&
          t.descriptor.text === d.text &&
          t.descriptor.role === d.role &&
          t.descriptor.hrefPath === d.hrefPath)
    ) ?? null
  );
}

// ── массовые операции (§5-кватер.12): Shift+клик или рамкой ──
function bulkView(): HTMLElement {
  const L0 = L();
  const box = h('div', { class: 'card' });
  const list = S.multi;
  const run =
    (patch: Record<string, unknown>, tpl = false) =>
    async () => {
      const segs = S.path.split('/').filter(Boolean);
      const mask =
        S.map?.template?.pathPattern ??
        (segs.length > 1 ? `/${segs.slice(0, -1).join('/')}/*` : '/*');
      const tid = tpl ? await templateId(mask) : null;
      if (tpl && !tid) return;
      const fwd: unknown[] = [];
      const back: unknown[] = [];
      const taken = new Set(S.map?.keys ?? []);
      for (const d of list) {
        const t = targetFor(d);
        let k = t?.key ?? suggestKey({ descriptor: d } as Picked);
        for (let i = 2; !t && taken.has(k); i++)
          k = `${k.replace(/-\d+$/, '')}-${i}`;
        taken.add(k);
        const denied = patch.denylisted === true;
        fwd.push({
          op: 'upsert-target',
          target: {
            ...(t ?? {
              key: k,
              scope: 'page',
              pagePath: S.path,
              descriptor: d,
              names: d.text ? { [S.lang]: d.text.replace(/…$/, '') } : {},
            }),
            ...(tid
              ? { scope: 'template', templateId: tid, pagePath: null }
              : {}),
            ...(denied ? { names: {}, synonyms: {} } : {}),
            ...patch,
            ...(t ? { descriptor: undefined } : {}),
          },
        });
        back.push(
          t
            ? { op: 'upsert-target', target: t }
            : { op: 'remove-target', key: k }
        );
      }
      if (await ops(fwd, back, `×${list.length}`)) S.multi = [];
      render();
    };
  const b = (label: string, fn: () => Promise<void>) =>
    h('button', { type: 'button', click: human(() => void fn()) }, label);
  box.append(
    h('p', {}, fmt(L0.bulk, { n: list.length })),
    h(
      'div',
      { class: 'acts' },
      b(L0.bAdd, run({})),
      b(L0.bDeny, run({ denylisted: true })),
      b(L0.bRisk, run({ riskOwner: 'confirm' })),
      b(L0.bCtl, run({ control: true })),
      b(L0.bTpl, run({}, true)),
      b('✕', async () => {
        S.multi = [];
        render();
      })
    )
  );
  return box;
}

// ── вкладки ──
function cardView(): HTMLElement {
  if (S.multi.length) return bulkView();
  const p = S.picked;
  if (!p) return h('p', { class: 'hint' }, L().pickHint);
  const t = S.edit;
  const d = p.descriptor;
  const box = h('div', { class: 'card' });
  const syn = S.pendingSyn;
  if (syn && t && syn.key === t.key)
    box.append(
      h(
        'button',
        {
          type: 'button',
          class: 'pri',
          click: human(() => {
            S.pendingSyn = null;
            void ops(
              [
                {
                  op: 'add-synonym',
                  key: t.key,
                  lang: S.lang,
                  text: syn.phrase,
                },
              ],
              [{ op: 'upsert-target', target: t }],
              t.key
            );
          }),
        },
        `+ «${syn.phrase}» → ${t.key}`
      )
    );
  box.append(
    h(
      'div',
      { class: 'pick' },
      `${d.text ? `«${d.text}»` : '—'} · ${d.role || d.tag} · ${p.how} · ${p.stability}`
    )
  );
  if (p.never) box.append(h('p', { class: 'warn' }, L().never));
  else if (p.stability === 'fragile')
    box.append(h('p', { class: 'warn' }, L().fragile));
  const key = h('input', {
    name: 'key',
    value: t?.key ?? suggestKey(p),
    maxlength: '40',
  }) as HTMLInputElement;
  if (t) key.disabled = true;
  const names: Record<string, HTMLInputElement> = {};
  const syns: Record<string, HTMLInputElement> = {};
  const langs: PanelLang[] = ['uk', 'ru', 'en'];
  const namesBox = h('fieldset', {}, h('legend', {}, L().names));
  for (const l of langs) {
    names[l] = h('input', {
      name: `name-${l}`,
      maxlength: '60',
      placeholder: l,
      value:
        t?.names[l] ??
        (l === S.lang && !p.never ? d.text.replace(/…$/, '') : ''),
    }) as HTMLInputElement;
    syns[l] = h('input', {
      name: `syn-${l}`,
      placeholder: `${L().synonyms} · ${l}`,
      value: t
        ? (t.synonyms[l] ?? [])
            .filter((s) => s.origin !== 'suggested')
            .map((s) => s.text)
            .join(', ')
        : l === S.lang && S.pendingSyn && !S.pendingSyn.key
          ? S.pendingSyn.phrase
          : '',
    }) as HTMLInputElement;
    namesBox.append(h('div', { class: 'row' }, names[l], syns[l]));
  }
  const type = h(
    'select',
    { name: 'type' },
    h('option', { value: '' }, '—'),
    ...TYPES.map((x) => h('option', { value: x }, x))
  ) as HTMLSelectElement;
  type.value =
    t?.semanticType ??
    (d.assistId === 'add-to-cart' ? 'add-to-cart' : d.tag === 'a' ? 'nav' : '');
  const risk = h(
    'select',
    { name: 'risk' },
    h('option', { value: '' }, L().riskAuto),
    ...(['now', 'confirm', 'never'] as Risk[])
      .filter((r) => !t || RANK[r] >= RANK[t.riskComputed])
      .map((r) =>
        h(
          'option',
          { value: r },
          L()[
            r === 'now'
              ? 'riskNow'
              : r === 'confirm'
                ? 'riskConfirm'
                : 'riskNever'
          ]
        )
      )
  ) as HTMLSelectElement;
  risk.value = t?.riskOwner ?? '';
  const deny = h('input', {
    type: 'checkbox',
    name: 'deny',
  }) as HTMLInputElement;
  deny.checked = t?.denylisted ?? (p.never || d.neverAttr);
  const control = h('input', {
    type: 'checkbox',
    name: 'control',
  }) as HTMLInputElement;
  control.checked = t?.control ?? false;
  const scope = h(
    'select',
    { name: 'scope' },
    h('option', { value: 'page' }, L().scopePage),
    h('option', { value: 'template' }, L().scopeTemplate),
    h('option', { value: 'site' }, L().scopeSite)
  ) as HTMLSelectElement;
  scope.value = t?.scope ?? (S.map?.template ? 'template' : 'page');
  const segs = S.path.split('/').filter(Boolean);
  const mask = h('input', {
    name: 'mask',
    value:
      S.map?.template?.pathPattern ??
      (segs.length > 1 ? `/${segs.slice(0, -1).join('/')}/*` : '/*'),
  }) as HTMLInputElement;
  const undo = h('input', {
    name: 'undo',
    placeholder: 'remove-from-cart',
    value: t?.undo?.assistId ?? '',
  }) as HTMLInputElement;
  box.append(
    h('label', {}, L().key, key),
    namesBox,
    h('label', {}, L().type, type),
    h(
      'label',
      {},
      `${L().risk}${t ? ` · ${fmt(L().computed, { r: t.riskComputed })}` : ''}`,
      risk
    ),
    h('label', { class: 'chk' }, deny, L().deny),
    h('label', { class: 'chk' }, control, L().control),
    h('label', {}, L().scope, scope),
    h('label', {}, L().newTemplate, mask),
    h('label', {}, L().undo, undo)
  );
  if (!d.assistId) {
    const line = `data-assist-id="${key.value}"`;
    box.append(
      h(
        'div',
        { class: 'snip' },
        L().snippet,
        h('code', {}, line),
        h(
          'button',
          {
            type: 'button',
            click: () => void navigator.clipboard?.writeText(line),
          },
          L().copy
        )
      )
    );
  }
  const save = human(async () => {
    const k = key.value.trim();
    const list = (v: string) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((text) => ({ text, origin: 'owner' }));
    const opsList: unknown[] = [];
    const tplId =
      scope.value === 'template' ? await templateId(mask.value.trim()) : null;
    if (scope.value === 'template' && !tplId) return;
    const denied = deny.checked;
    opsList.push({
      op: 'upsert-target',
      target: {
        key: k,
        scope: scope.value,
        templateId: tplId,
        pagePath: scope.value === 'page' ? S.path : null,
        descriptor: t ? undefined : d,
        names: denied
          ? {}
          : Object.fromEntries(
              langs.map((l) => [l, names[l].value.trim()]).filter(([, v]) => v)
            ),
        synonyms: denied
          ? {}
          : Object.fromEntries(
              langs
                .map((l) => [l, list(syns[l].value)])
                .filter(([, v]) => v.length)
            ),
        semanticType: type.value || null,
        riskOwner: risk.value || null,
        denylisted: denied,
        control: control.checked,
        undo: undo.value.trim()
          ? { assistId: undo.value.trim(), at: null }
          : null,
      },
    });
    const inverse = t
      ? [{ op: 'upsert-target', target: t }]
      : [{ op: 'remove-target', key: k }];
    void ops(opsList, inverse, k);
  });
  box.append(
    h(
      'div',
      { class: 'acts' },
      h('button', { type: 'button', class: 'pri', click: save }, L().save)
    )
  );
  if (t)
    box.append(
      h(
        'button',
        {
          type: 'button',
          click: human(
            () =>
              void ops(
                [
                  {
                    op:
                      t.status === 'removed'
                        ? 'restore-target'
                        : 'remove-target',
                    key: t.key,
                  },
                ],
                [
                  {
                    op:
                      t.status === 'removed'
                        ? 'remove-target'
                        : 'restore-target',
                    key: t.key,
                  },
                ],
                t.key
              )
          ),
        },
        t.status === 'removed' ? L().restore : L().remove
      )
    );
  return box;
}

function pageView(): HTMLElement {
  const m = S.map;
  const box = h('div', {});
  if (S.counts)
    box.append(
      h(
        'p',
        { class: 'cnt' },
        fmt(L().counts, {
          g: S.counts.green,
          y: S.counts.yellow,
          r: S.counts.red,
          v: S.counts.violet,
        })
      )
    );
  if (!m || !m.targets.length) {
    box.append(h('p', { class: 'hint' }, L().empty));
    return box;
  }
  // Поиск цели (`/`): имя, ключ, подпись, синонимы.
  const q = h('input', {
    name: 'q',
    placeholder: L().search,
    value: S.q,
  }) as HTMLInputElement;
  q.addEventListener('input', () => {
    S.q = q.value;
    render();
    const n = document.querySelector<HTMLInputElement>('input[name="q"]');
    n?.focus();
    n?.setSelectionRange(n.value.length, n.value.length);
  });
  box.append(q);
  const needle = S.q.trim().toLowerCase();
  const ul = h('ul', { class: 'list' });
  for (const t of m.targets) {
    if (
      needle &&
      ![
        t.key,
        t.descriptor.text,
        ...Object.values(t.names),
        ...Object.values(t.synonyms).flatMap((l) =>
          (l || []).map((x) => x.text)
        ),
      ].some((x) => (x || '').toLowerCase().includes(needle))
    )
      continue;
    const found = S.samples.get(t.key);
    ul.append(
      h(
        'li',
        { class: `${colorOf(t)}${t.status === 'removed' ? ' off' : ''}` },
        h(
          'button',
          {
            type: 'button',
            click: () => open(t),
          },
          `${t.names[S.lang] || t.descriptor.text || t.key} · ${t.key} · ${effective(t)}${found !== undefined ? ` · ${fmt(L().found, { n: found })}` : ''}`
        )
      )
    );
  }
  box.append(ul);
  box.append(
    h(
      'button',
      {
        type: 'button',
        click: human(() => void checkSamples()),
      },
      L().check
    )
  );
  return box;
}

/** Образцы устойчивости: пикер разрешает дескрипторы на ЭТОЙ странице (§5-кватер.4). */
async function checkSamples(): Promise<void> {
  const m = S.map;
  if (!m) return;
  const active = m.targets.filter(
    (t) => t.status === 'active' && t.scope !== 'site'
  );
  const id = ++S.reqId;
  const r = await ask({
    type: 'resolve',
    id,
    items: active.map((t) => ({
      key: t.key,
      descriptor: t.descriptor,
      color: colorOf(t),
    })),
  });
  if (r.type !== 'resolved') return;
  for (const i of r.items) S.samples.set(i.key, i.found);
  const list = r.items
    .filter((i) => active.some((t) => t.key === i.key))
    .map((i) => ({ op: 'sample', key: i.key, path: S.path, found: i.found }));
  if (list.length) await ops(list, null, 'sample');
  else render();
}

function tryView(): HTMLElement {
  const box = h('div', {});
  const input = h('input', {
    name: 'say',
    placeholder: L().sayPh,
    maxlength: '200',
    value: S.say,
  }) as HTMLInputElement;
  const run = human(() => void runTry(input.value.trim()));
  box.append(
    h(
      'div',
      { class: 'row' },
      input,
      h(
        'button',
        {
          type: 'button',
          click: human(() => void mic()),
        },
        S.mic ? '■' : '🎤'
      ),
      h('button', { type: 'button', class: 'pri', click: run }, L().say)
    )
  );
  const r = S.tryRes;
  if (r) {
    const via = L()[`via_${r.via}`] || r.via;
    box.append(
      h(
        'p',
        {},
        `«${r.heard}» — ${fmt(via, { p: r.phrase ?? '', k: r.key ?? '' })}`
      )
    );
    if (r.via !== 'map' && r.key)
      box.append(h('p', { class: 'warn' }, fmt(L().miss, { k: r.key })));
    if (!r.steps.length) box.append(h('p', { class: 'hint' }, L().stepsNone));
    const ol = h('ol', {});
    for (const s of r.steps)
      ol.append(h('li', {}, `${s.kind} «${s.target?.text ?? ''}» · ${s.risk}`));
    for (const n of r.notes)
      ol.append(
        h(
          'li',
          { class: 'off' },
          `${n.code}${n.target ? ` «${n.target}»` : ''}`
        )
      );
    box.append(ol, h('p', { class: 'hint' }, fmt(L().left, { n: r.left })));
    box.append(
      h(
        'button',
        {
          type: 'button',
          click: human(() => {
            S.wrongFor = r.heard;
            S.note = L().wrongPick;
            toPicker({ type: 'mode', mode: 'select' });
            render();
          }),
        },
        L().wrong
      )
    );
  }
  return box;
}

/**
 * Микрофон «Сказать сейчас» (§5-кватер.6 п.1): запись в памяти вкладки →
 * `POST /editor/v1/voice` (сессия редактора, потолок «Сказать сейчас») →
 * текст в поле и та же проверка `/editor/v1/try`. Второе нажатие — стоп.
 */
async function mic(): Promise<void> {
  if (S.mic) return void S.mic.stop();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    return fail(e);
  }
  let rec: MediaRecorder;
  try {
    rec = new MediaRecorder(stream);
  } catch (e) {
    // Аудит P3: запись не создалась — микрофон не остаётся включённым.
    stream.getTracks().forEach((t) => t.stop());
    return fail(e);
  }
  const parts: Blob[] = [];
  rec.ondataavailable = (e) => parts.push(e.data);
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    S.mic = null;
    const blob = new Blob(parts, { type: rec.mimeType || 'audio/webm' });
    try {
      const v = await api<{ text: string }>(
        '/editor/v1/voice',
        { method: 'POST', body: blob },
        blob.type.split(';')[0]
      );
      await runTry(v.text);
    } catch (e) {
      fail(e);
    }
  };
  rec.onerror = () => rec.state !== 'inactive' && rec.stop();
  S.mic = rec;
  try {
    rec.start();
  } catch (e) {
    S.mic = null;
    stream.getTracks().forEach((t) => t.stop());
    return fail(e);
  }
  render();
  // Не дольше 30 с, как запись посетителя.
  setTimeout(() => S.mic === rec && rec.stop(), 30_000);
}

async function runTry(text: string): Promise<void> {
  if (!text) return;
  S.say = text;
  const id = ++S.reqId;
  const r = await ask({ type: 'snapshot-req', id });
  if (r.type !== 'snapshot') return;
  try {
    S.tryRes = await api<TryView>('/editor/v1/try', {
      method: 'POST',
      body: JSON.stringify({ text, snapshot: r.snapshot }),
    });
    // Показ без нажатий: пикер подсвечивает цели шагов с подписью.
    toPicker({
      type: 'highlight',
      items: S.tryRes.steps
        .filter((s) => s.target)
        .map((s) => ({
          ref: s.target!.ref,
          label: `${s.i + 1}. ${s.kind} · ${s.risk}`,
        })),
    });
  } catch (e) {
    fail(e);
  }
  render();
}

function publishView(): HTMLElement {
  const m = S.map;
  const box = h('div', {});
  if (m) {
    box.append(
      h('p', {}, fmt(L().version, { v: m.publishedVersion, r: m.revision }))
    );
    box.append(
      h(
        'p',
        { class: m.gates.ok ? 'ok' : 'warn' },
        m.gates.ok
          ? L().gatesOk
          : fmt(L().gatesBad, { n: m.gates.problems.length })
      )
    );
    const ul = h('ul', {});
    for (const p of m.gates.problems.slice(0, 20))
      ul.append(h('li', {}, `${p.code}${p.key ? ` · ${p.key}` : ''}`));
    box.append(ul);
  }
  box.append(
    h(
      'button',
      {
        type: 'button',
        class: 'pri',
        click: human(async () => {
          try {
            const v = await api<{ number: number; status: string }>(
              '/editor/v1/publish-request',
              { method: 'POST', body: '{}' }
            );
            S.note = fmt(L().requested, { n: v.number, s: v.status });
          } catch (e) {
            fail(e);
          }
          render();
        }),
      },
      L().request
    )
  );
  return box;
}

function render(): void {
  const root = document.getElementById('app');
  if (!root) return;
  while (root.firstChild) root.removeChild(root.firstChild);
  if (S.fatal) {
    root.append(h('div', { class: 'fatal' }, S.fatal));
    return;
  }
  const tabs = h('nav', { class: 'tabs' });
  for (const [id, label] of [
    ['target', L().tabTarget],
    ['page', L().tabPage],
    ['memo', L().tabMemo],
    ['try', L().tabTry],
    ['publish', L().tabPublish],
  ] as const)
    tabs.append(
      h(
        'button',
        {
          type: 'button',
          class: S.tab === id ? 'on' : '',
          click: () => {
            S.tab = id;
            render();
          },
        },
        label
      )
    );
  root.append(tabs);
  if (S.note) root.append(h('p', { class: 'note' }, S.note));
  root.append(
    S.tab === 'target'
      ? cardView()
      : S.tab === 'page'
        ? pageView()
        : S.tab === 'memo'
          ? memo.view()
          : S.tab === 'try'
            ? tryView()
            : publishView()
  );
  root.append(
    h(
      'button',
      {
        type: 'button',
        class: 'exit',
        click: human(async () => {
          // Сессия гаснет на сервере ДО снятия пикера (iframe уйдёт вместе с ним).
          await api('/editor/v1/exit', { method: 'POST', body: '{}' }).catch(
            () => null
          );
          try {
            sessionStorage.removeItem(STORE);
            sessionStorage.removeItem(`${STORE}:m`);
          } catch {
            /* — */
          }
          toPicker({ type: 'exit' });
          S.fatal = L().exited;
          render();
        }),
      },
      L().exit
    )
  );
  if (S.undo.length)
    root.append(
      h(
        'button',
        {
          type: 'button',
          class: 'undo',
          click: human(() => {
            const u = S.undo.pop();
            if (u) void ops(u.ops, null, u.label);
          }),
        },
        L().undoLast
      )
    );
}

// ── сообщения пикера: только родитель с origin ссылки ──
window.addEventListener('message', (e) => {
  if (
    e.source !== window.parent ||
    !S.parentOrigin ||
    e.origin !== S.parentOrigin
  )
    return;
  const m = parseToPanel(e.data);
  if (!m) return;
  if ((m.type === 'snapshot' || m.type === 'resolved') && S.waiting.has(m.id)) {
    const fn = S.waiting.get(m.id)!;
    S.waiting.delete(m.id);
    fn(m);
    return;
  }
  switch (m.type) {
    case 'ready':
      S.lang = m.lang === 'ru' || m.lang === 'en' ? m.lang : 'uk';
      S.path = m.path;
      if (S.session) void loadMap();
      else S.pendingLoad = true;
      return;
    case 'route':
      S.path = m.path;
      void loadMap();
      return;
    case 'counts':
      S.counts = m;
      if (S.tab === 'page') render();
      return;
    case 'search':
      S.tab = 'page';
      render();
      document.querySelector<HTMLInputElement>('input[name="q"]')?.focus();
      return;
    case 'picks':
      addMulti(m.items);
      return;
    case 'pick': {
      // Shift+клик — к массовому выбору (не запись и не карточка).
      if (m.multi && !memo.active()) return addMulti([m.descriptor]);
      // Запись мемо / перепривязка шага: клик — шаг (решает сервер).
      if (memo.active()) {
        S.tab = 'memo';
        void memo.onPick(m);
        return;
      }
      // «Не то → выбрать»: фраза команды становится синонимом выбранной цели.
      if (S.wrongFor) {
        const t = targetFor(m.descriptor);
        S.pendingSyn = { key: t ? t.key : null, phrase: S.wrongFor };
        S.wrongFor = null;
      }
      S.picked = {
        descriptor: m.descriptor,
        how: m.how,
        stability: m.stability,
        never: m.never,
      };
      S.edit = targetFor(m.descriptor);
      S.tab = 'target';
      render();
      return;
    }
  }
});

function addMulti(items: Descriptor[]): void {
  // Одинаковые элементы (24 «В кошик» в списке) — одна цель (§5-кватер.12).
  const id = (d: Descriptor) =>
    `${d.assistId}|${d.text}|${d.role}|${d.hrefPath}`;
  for (const d of items)
    if (S.multi.length < 40 && !S.multi.some((x) => id(x) === id(d)))
      S.multi.push(d);
  S.tab = 'target';
  render();
}

// `/` — поиск цели; `S` (удерживать) — микрофон «Сказать сейчас».
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT' || e.repeat) return;
  if (e.key === '/') {
    e.preventDefault();
    S.tab = 'page';
    render();
    document.querySelector<HTMLInputElement>('input[name="q"]')?.focus();
  } else if (e.key === 's' && !S.mic) {
    S.tab = 'try';
    void mic();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === 's' && S.mic) S.mic.stop();
});

async function boot(): Promise<void> {
  const hash = location.hash;
  const token = /^#t=([A-Za-z0-9_-]{20,128})$/.exec(hash)?.[1] ?? null;
  // Токен — одноразовый: фрагмент снимается сразу (история iframe).
  if (hash) history.replaceState(null, '', location.pathname + location.search);
  const anc = (
    location as unknown as {
      ancestorOrigins?: { length: number; [i: number]: string };
    }
  ).ancestorOrigins;
  let guess = anc && anc.length ? anc[0] : '';
  if (!guess)
    try {
      guess = document.referrer ? new URL(document.referrer).origin : '';
    } catch {
      guess = '';
    }
  // Сообщения пикера принимаются только с этого origin; сервер сверяет его
  // с origin хоста ссылки при обмене (не совпал — отказ).
  S.parentOrigin = guess;
  try {
    if (token) {
      const s = await api<{ session: string; focusKey: string | null }>(
        '/editor/v1/session',
        {
          method: 'POST',
          body: JSON.stringify({ token, parentOrigin: guess }),
        }
      );
      S.session = s.session;
      S.focusKey = typeof s.focusKey === 'string' ? s.focusKey : null;
      memo.reset();
      S.parentOrigin = guess;
      try {
        sessionStorage.setItem(
          STORE,
          JSON.stringify({ s: s.session, o: guess })
        );
      } catch {
        /* продолжение после перехода — недоступно */
      }
    } else {
      const raw = sessionStorage.getItem(STORE);
      const saved = raw
        ? (JSON.parse(raw) as { s?: string; o?: string })
        : null;
      if (!saved?.s || saved.o !== guess)
        throw Object.assign(new Error(''), { status: 403 });
      S.session = saved.s;
      S.parentOrigin = guess;
      // Запись мемо продолжается на новой странице (MPA).
      if (memo.has()) S.tab = 'memo';
    }
  } catch {
    S.fatal = L().linkBad;
    // Продолжение после перехода без живой сессии — пикер уходит сам
    // (иначе вкладка владельца так и перехватывала бы клики).
    if (!token) toPicker({ type: 'exit' });
    // Аудит Э6-тер: чужая/старая ссылка `?v4c_edit=` у посетителя не
    // «замораживает» страницу — клики уходят сайту, видна только ошибка.
    else toPicker({ type: 'mode', mode: 'nav' });
  }
  render();
  // Пикер шлёт `ready` по load iframe — он мог прийти раньше обмена.
  if (S.session && S.pendingLoad) void loadMap();
}

void boot();
