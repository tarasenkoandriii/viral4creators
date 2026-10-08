/**
 * Вкладка «Мемо» панели редактора (Э6-тер (д), ТЗ §5-бис.17 п.6–8,
 * §5-кватер.5): «Записати» → клики владельца по сайту (пикер, режим
 * «Вибір») становятся шагами; каждый шаг делает СЕРВЕР
 * (`/editor/v1/memo/record/step`): поле/список — слот без значения, опасное —
 * запись стоп; переход и раскрытие сервер разрешает исполнить по-настоящему
 * (`perform`). Перепривязка (⌖ → клик по другому элементу), ↑/↓/✕, имя и
 * цель; «Зберегти чернетку» — черновик мемо (ворота — на сервере); «Прогнати»
 * — шаги черновика по снимку этой страницы до первого сбоя.
 *
 * Состояние записи — в `sessionStorage` origin `we.` (переживает переход
 * MPA, как сессия); черновик меняет только клик человека здесь (`isTrusted`).
 *
 * Заход 9: без открытой записи — список всех мемо сайта (`memo/list`,
 * клик — открыть); «Чекати це» — следующий клик по сайту не шаг, а
 * ожидание (`record/wait`: появление элемента у выбранного шага или цель
 * «лічильник +1»); у шага — «Як скасувати» его цели карты (↶, правка — в
 * карточке цели).
 */
import type { ToPanel, ToPicker } from '../shared/editor-protocol';
import { fmt } from './i18n';

interface Undo {
  assistId: string;
  key: string | null;
}
interface Step {
  action: string;
  page: string;
  target: { pin: { text: string }; mapKey?: string | null } | null;
  value: { slot: string } | null;
  expect?: { appear?: string } | null;
  /** «Як скасувати» цели карты — только показ (сервер его не читает). */
  u?: Undo | null;
}
interface Counter {
  target: { assistId: string | null; text: string };
  delta: number;
}
interface Slot {
  name: string;
}
interface Rec {
  on: boolean;
  memo: number | null;
  rev: number | null;
  key: string | null;
  steps: Step[];
  /** «⚠» — в бою после «Да» (по расчёту кода при записи). */
  warn: boolean[];
  slots: Slot[];
  name: string;
  goal: string;
  sel: number | null;
  rebind: boolean;
  from: number;
  res: string;
  wait?: boolean;
  /** Цель «лічильник ±N»: `undefined` — не трогали, `null` — снять. */
  cnt?: Counter | null;
}
interface Item {
  number: number;
  name: string | null;
  status: string;
  page: string | null;
}
type Pick = Extract<ToPanel, { type: 'pick' }>;

export interface MemoDeps {
  h: (
    tag: string,
    attrs?: Record<string, string | boolean | ((e: Event) => void)>,
    ...kids: Array<Node | string | null | false>
  ) => HTMLElement;
  human: (fn: () => void) => (e: Event) => void;
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  toPicker: (m: ToPicker) => void;
  snapshot: () => Promise<unknown>;
  L: () => Record<string, string>;
  lang: () => string;
  path: () => string;
  note: (s: string) => void;
  fail: (e: unknown) => void;
  render: () => void;
  store: string;
  /** Открыть карточку цели карты (правка «Як скасувати»). */
  edit: (key: string) => void;
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
});

export function createMemo(d: MemoDeps) {
  const K = `${d.store}:m`;
  let r: Rec | null = null;
  let list: Item[] | null = null;
  try {
    const raw = sessionStorage.getItem(K);
    r = raw ? (JSON.parse(raw) as Rec) : null;
  } catch {
    r = null;
  }
  const save = () => {
    try {
      if (r) sessionStorage.setItem(K, JSON.stringify(r));
      else sessionStorage.removeItem(K);
    } catch {
      /* без хранилища — запись только на этой странице */
    }
    d.render();
  };
  const fresh = (): Rec => ({
    on: false,
    memo: null,
    rev: null,
    key: null,
    steps: [],
    warn: [],
    slots: [],
    name: '',
    goal: '',
    sel: null,
    rebind: false,
    from: 0,
    res: '',
  });

  /** Начать запись (новое мемо — лимит тарифа сразу) или открыть мемо N. */
  async function open(memo: number | null, step: number | null = null) {
    try {
      const v = await d.api<{
        memo: {
          number: number;
          key: string;
          draftRevision: number;
          name: string | null;
          goalText: string | null;
          steps: Step[];
          slots: Slot[];
          undo: Array<Undo | null>;
          counter: Counter | null;
        } | null;
      }>(
        '/editor/v1/memo/record/start',
        post({ path: d.path(), memo, lang: d.lang() })
      );
      const m = v.memo;
      r = fresh();
      if (m) {
        r.memo = m.number;
        r.rev = m.draftRevision;
        r.key = m.key;
        r.steps = m.steps.map((x, i) => ({ ...x, u: (m.undo || [])[i] }));
        r.warn = m.steps.map(() => false);
        r.cnt = m.counter;
        r.slots = m.slots;
        r.name = m.name ?? '';
        r.goal = m.goalText ?? '';
        r.sel = step !== null && step < m.steps.length ? step : null;
      } else {
        r.on = true;
        d.toPicker({ type: 'mode', mode: 'select' });
      }
      d.note(m ? fmt(d.L().mOpened, { n: m.number }) : d.L().mHint);
      save();
    } catch (e) {
      d.fail(e);
    }
  }

  /** Клик владельца на странице → шаг (или перепривязка выбранного шага). */
  async function onPick(m: Pick): Promise<boolean> {
    if (!r || (!r.on && !r.rebind && !r.wait)) return false;
    const rb = r.rebind && r.sel !== null ? r.sel : null;
    if (r.wait) {
      // «Чекати це»: ожидание, не шаг и не нажатие.
      r.wait = false;
      try {
        const w = await d.api<
          { kind: 'appear'; text: string } | ({ kind: 'counter' } & Counter)
        >(
          '/editor/v1/memo/record/wait',
          post({ path: d.path(), descriptor: m.descriptor })
        );
        if (w.kind === 'counter') r.cnt = { target: w.target, delta: w.delta };
        else {
          const s = r.steps[r.sel ?? r.steps.length - 1];
          if (s) s.expect = { ...(s.expect || {}), appear: w.text };
        }
      } catch (e) {
        d.fail(e);
      }
      save();
      return true;
    }
    try {
      const v = await d.api<
        | {
            kind: 'step';
            step: Step;
            slot: Slot | null;
            risk: string;
            exec: boolean;
            undo: Undo | null;
          }
        | { kind: 'stop'; reason: string; step: Step | null }
      >(
        '/editor/v1/memo/record/step',
        post({
          path: d.path(),
          descriptor: m.descriptor,
          fieldName: m.fieldName,
          options: m.options,
          slots: r.slots.map((s) => s.name),
          count: r.steps.length,
          prev: rb !== null ? r.steps[rb] : undefined,
        })
      );
      const L = d.L();
      if (v.kind === 'stop') {
        const why = /^(offhost|gesture)$/.test(v.reason)
          ? L.mManual
          : v.reason === 'too_many_steps'
            ? L.mMax
            : L.mNever;
        d.note(`${why} (${v.reason})`);
        if (rb === null) {
          if (v.step) {
            r.steps.push(v.step);
            r.warn.push(true);
          }
          r.on = false;
        }
      } else {
        if (v.slot) r.slots.push(v.slot);
        v.step.u = v.undo;
        if (rb !== null) {
          r.steps[rb] = v.step;
          r.warn[rb] = v.risk !== 'auto';
          r.rebind = false;
        } else {
          r.steps.push(v.step);
          r.warn.push(v.risk !== 'auto');
        }
        d.note('');
        // Переход/раскрытие — по-настоящему (элемент настоящего клика).
        if (v.exec && rb === null && m.pid)
          d.toPicker({ type: 'perform', pid: m.pid });
      }
    } catch (e) {
      d.fail(e);
    }
    save();
    return true;
  }

  async function store() {
    if (!r) return;
    try {
      const v = await d.api<{
        number: number;
        key: string;
        draftRevision: number;
        gates: { ok: boolean; problems: unknown[] };
      }>(
        '/editor/v1/memo/record/stop',
        post({
          memo: r.memo,
          expectedRevision: r.rev,
          lang: d.lang(),
          name: r.name,
          goalText: r.goal,
          path: d.path(),
          steps: r.steps,
          slots: r.slots,
          goalCounter: r.cnt,
        })
      );
      list = null;
      r.memo = v.number;
      r.rev = v.draftRevision;
      r.key = v.key;
      r.on = false;
      d.note(
        fmt(d.L().mSaved, {
          n: v.number,
          p: v.gates.ok ? 0 : v.gates.problems.length,
        })
      );
    } catch (e) {
      d.fail(e);
    }
    save();
  }

  async function run() {
    if (!r || !r.key) return;
    const snapshot = await d.snapshot();
    if (!snapshot) return;
    try {
      const v = await d.api<{
        steps: Array<{
          i: number;
          ok: boolean;
          problem: string | null;
          ref: string | null;
          action: string;
        }>;
        stopAt: number | null;
        problem: string | null;
        next: { i: number; page: string } | null;
        goal: string | null;
        done: boolean;
      }>(
        `/editor/v1/memo/${encodeURIComponent(r.key)}/try`,
        post({ snapshot, from: r.from })
      );
      const L = d.L();
      // Подсветка по ходу — без нажатий: номер шага и ✓/✗.
      d.toPicker({
        type: 'highlight',
        items: v.steps
          .filter((s) => s.ref)
          .map((s) => ({
            ref: s.ref!,
            label: `${s.i + 1}. ${s.action} ${s.ok ? '✓' : '✗'}`,
          })),
      });
      if (v.stopAt !== null) {
        r.sel = v.stopAt;
        r.from = 0;
        r.res = fmt(L.mFail, {
          n: v.stopAt + 1,
          p: L[`p_${v.problem}`] || v.problem || '',
        });
      } else if (v.next) {
        r.from = v.next.i;
        r.res = fmt(L.mNext, { n: v.next.i + 1, p: v.next.page });
      } else {
        r.from = 0;
        r.res = v.goal === 'missing' ? L.mGoalMiss : L.mDone;
      }
    } catch (e) {
      d.fail(e);
    }
    save();
  }

  function view(): HTMLElement {
    const { h, human } = d;
    const L = d.L();
    const box = h('div', { class: 'memo' });
    const btn = (label: string, fn: () => void, cls = '') =>
      h('button', { type: 'button', class: cls, click: human(fn) }, label);
    if (!r) {
      box.append(
        h('p', { class: 'hint' }, L.mIntro),
        btn(L.mRec, () => void open(null), 'pri')
      );
      if (!list) {
        list = [];
        d.api<{ items: Item[] }>(`/editor/v1/memo/list?lang=${d.lang()}`)
          .then((v) => {
            list = v.items;
            d.render();
          })
          .catch(d.fail);
      }
      const ul = h('ul', { class: 'list' });
      for (const m of list || [])
        ul.append(
          h(
            'li',
            {},
            btn(
              `М-${m.number} ${m.name ?? ''} · ${L[`s_${m.status}`] || m.status}${m.page ? ` · ${m.page}` : ''}`,
              () => void open(m.number)
            )
          )
        );
      box.append(ul);
      return box;
    }
    const rec = r;
    const name = h('input', {
      name: 'memo-name',
      maxlength: '60',
      placeholder: L.mName,
      value: rec.name,
    }) as HTMLInputElement;
    name.addEventListener('change', () => {
      rec.name = name.value;
      save();
    });
    const goal = h('input', {
      name: 'memo-goal',
      maxlength: '160',
      placeholder: L.mGoal,
      value: rec.goal,
    }) as HTMLInputElement;
    goal.addEventListener('change', () => {
      rec.goal = goal.value;
      save();
    });
    box.append(
      h(
        'p',
        { class: rec.on ? 'warn' : 'hint' },
        rec.on ? L.mOn : `${rec.memo ? `М-${rec.memo}` : ''}`
      ),
      name,
      goal
    );
    const ol = h('ol', { class: 'steps' });
    rec.steps.forEach((s, i) => {
      const move = (to: number) => () => {
        const [x] = rec.steps.splice(i, 1);
        rec.steps.splice(to, 0, x);
        const [w] = rec.warn.splice(i, 1);
        rec.warn.splice(to, 0, w);
        rec.sel = to;
        save();
      };
      ol.append(
        h(
          'li',
          { class: rec.sel === i ? 'on' : '' },
          h(
            'button',
            {
              type: 'button',
              class: 'lnk',
              click: () => {
                rec.sel = rec.sel === i ? null : i;
                save();
              },
            },
            `${s.action} «${s.target?.pin.text ?? ''}»${s.value ? ` {${s.value.slot}}` : ''}${rec.warn[i] ? ' ⚠' : ''}${s.expect?.appear ? ` → «${s.expect.appear}»` : ''}${s.u ? ` ↶${s.u.assistId}` : ''}`
          ),
          !!s.u?.key && btn('↶', () => d.edit(s.u!.key!)),
          i > 0 && btn('↑', move(i - 1)),
          i < rec.steps.length - 1 && btn('↓', move(i + 1)),
          btn('⌖', () => {
            rec.sel = i;
            rec.rebind = true;
            d.note(L.mRebind);
            d.toPicker({ type: 'mode', mode: 'select' });
            save();
          }),
          btn('✕', () => {
            rec.steps.splice(i, 1);
            rec.warn.splice(i, 1);
            rec.sel = null;
            save();
          })
        )
      );
    });
    box.append(ol);
    const c = rec.cnt;
    if (c)
      box.append(
        h(
          'p',
          { class: 'hint' },
          `${L.mCnt} «${c.target.text || c.target.assistId}» ${c.delta > 0 ? '+' : ''}${c.delta} `,
          btn('✕', () => {
            rec.cnt = null;
            save();
          })
        )
      );
    if (rec.res) box.append(h('p', { class: 'note' }, rec.res));
    box.append(
      h(
        'div',
        { class: 'acts' },
        btn(rec.on ? L.mStop : L.mRec, () => {
          rec.on = !rec.on;
          if (rec.on) d.toPicker({ type: 'mode', mode: 'select' });
          save();
        }),
        btn(rec.wait ? '…' : L.mWait, () => {
          rec.wait = true;
          d.note(L.mWaitHint);
          d.toPicker({ type: 'mode', mode: 'select' });
          save();
        }),
        btn(L.mSave, () => void store(), 'pri'),
        rec.key && btn(L.mTry, () => void run()),
        btn(L.mNew, () => {
          r = null;
          list = null;
          d.toPicker({ type: 'highlight', items: [] });
          save();
        })
      )
    );
    return box;
  }

  return {
    view,
    open,
    onPick,
    active: () => !!r && (r.on || r.rebind || !!r.wait),
    has: () => !!r,
    /** Новая ссылка редактора — запись прошлой сессии не продолжается. */
    reset: () => {
      r = null;
      save();
    },
  };
}
