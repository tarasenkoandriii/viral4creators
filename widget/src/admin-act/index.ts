/**
 * Голосовое управление «Админкой» — ленивый чанк `admin.js` на странице
 * админки заказчика `dist/v1/admin-act.js` (Э6-бис (б), ТЗ §5-бис.3,
 * §5-бис.5 «Админка», §5-бис.13; бюджет — scripts/size-budget.mjs; admin.js
 * и act.js не растут). Грузится только по команде своего iframe `wa.`
 * (после речи или набора сотрудника, либо в сессии мастера проверки).
 *
 * Исполнитель и снимок — те же, что у «Сайта» (`../act/exec`,
 * `../act/snapshot`; проверки по живому DOM, стоп, `dispatched` → `ui-ack`),
 * плюс правила «Админки»:
 *  - строки таблиц без `data-assist-id` в снимок не попадают (ПД клиентов и
 *    заказов не уходят на сервер), КРОМЕ строки с номером ≥ 3 цифр, который
 *    сотрудник сам назвал в команде (`rows` из iframe, Р-Э6б-6);
 *  - клик по цели «никогда» (удаление, отмена, возврат, оплата) не
 *    исполняется НИКОГДА: проверкой исполнителя, второй линией перед
 *    каждым событием нажатия (`_never`: `pointerdown`/`mousedown`/…,
 *    №91 — сайт мог удалять уже на `mousedown`) и обёрткой нативного
 *    `click`; в сессии мастера (`vt-arm`) каждая такая попытка — сообщение
 *    `ui-attempt` (регистратор: попытка > 0 — провал);
 *  - мастер на РАБОЧЕМ хосте (`vt-arm` с `work`): отправка формы во время
 *    плана глушится (`submit` в фазе перехвата) и регистрируется `vt-submit`;
 *    там же (Р-З9-22, аудит Э6-бис (б) (7)) — не-GET `fetch`,
 *    `XMLHttpRequest.send` и `sendBeacon` с отметки `dispatched` шага
 *    до 1 с после его итога (автосохранение в обработчике `change`/клика).
 *    Всё это — только для планов мастера (`ui-run` с `vt`, до отчёта):
 *    после мастера обычные планы сотрудника не глушатся;
 *  - окружение и разметка мастера — чанк `check.js`, возврат полей —
 *    `undo.js` (оба рядом, тот же выпуск).
 *
 * Исполняется в origin заказчика: никаких HTML-приёмников, никаких
 * запросов, кроме своих чанков; только сообщения своему iframe.
 */
import type { ActApi, ActHost } from '../act';
import { mem, Runner, wordsOf as wordList, type ActNatives } from '../act/exec';
import {
  closestDeep,
  factsOf,
  takeSnapshot,
  visibleText,
} from '../act/snapshot';
import {
  maskLabel,
  neverTarget,
  parseUiCommand,
  type UiStep,
} from '../shared/ui-plan';

const ROW = /^[0-9]{3,12}$/;
const ACTION = new Set(['click', 'fill', 'select', 'check', 'navigate']);
const FORBIDDEN = new Set(['danger', 'payment', 'denied']);

/**
 * Строже стоп-листа «Сайта» (порт `admin-voice-rules.ts`, аудит Э6-бис (б)):
 * голый глагол «Скасувати/Отменить/Cancel/Повернути/Void/Trash» на цели,
 * адрес ссылки или формы с действием (`/delete`, `?action=trash`) и подписи
 * ВНУТРИ цели (иконка `title`/`aria-label`/`alt`, класс `icon-trash`).
 */
const ADMIN_WORDS = [
  /(?:^|[^\p{L}])(скасувати|скасуйте|скасуй|відмінити|відмініть|відміна|отменить|отмените|отмени|отмена|аннулировать|аннулируйте|анулювати|анулюйте|cancel|void)(?!\p{L})/iu,
  /(?:^|[^\p{L}])(повернути|поверніть|поверни|вернуть|верните|верни|return)(?!\p{L})(?!\s+(?:to|back|до|к|назад)(?!\p{L}))/iu,
  /(?:^|[^\p{L}])(trash|destroy|purge)(?!\p{L})/iu,
];
const DANGER_HREF =
  /(?:^|[/?&=_.;-])(delete|destroy|remove|trash|erase|purge|cancel|refund|void|charge|payout|withdraw)(?:[/?&=_.;-]|$)/i;
const DANGER_CLASS =
  /(?:^|[\s_-])(trash|delete|remove|bin|cancel|refund|destroy)(?:[\s_-]|$)/i;

const adminWords = (t: string) =>
  ADMIN_WORDS.some((re) => re.test(t.normalize('NFKC').toLowerCase()));

/** Путь+query адреса (живой — с query, в снимок он не уходит). */
function dangerUrl(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw, location.href);
    return DANGER_HREF.test(u.pathname + u.search);
  } catch {
    return false;
  }
}

/** Подписи внутри цели (иконки): `title`, `aria-label`, `alt`, `<title>`. */
function innerLabels(el: Element): string {
  const out: string[] = [];
  const list = el.querySelectorAll('[title],[aria-label],img[alt],svg title');
  for (let i = 0; i < list.length && i < 20; i++) {
    const n = list[i];
    out.push(
      n.getAttribute('title') ||
        n.getAttribute('aria-label') ||
        n.getAttribute('alt') ||
        n.textContent ||
        ''
    );
  }
  return out.join(' ').slice(0, 300);
}

/** Живая цель «Админки» — «никогда» (сверх `neverTarget`). */
function adminNever(el: Element, words: string): boolean {
  const inner = innerLabels(el);
  if (adminWords(words + ' ' + inner) || (inner && neverTarget(inner, null)))
    return true;
  const a = el.closest('a[href]');
  if (a && dangerUrl(a.getAttribute('href'))) return true;
  const f = el as HTMLInputElement;
  if (f.form && (f.type === 'submit' || f.type === 'image')) {
    if (
      dangerUrl(el.getAttribute('formaction') || f.form.getAttribute('action'))
    )
      return true;
  }
  return (
    DANGER_CLASS.test(el.getAttribute('class') || '') ||
    !!el.querySelector('[class*=trash],[class*=delete],[class*=remove]')
  );
}

/** Слова цели для стоп-листа: живой текст, скрытая подпись, разметка. */
function wordsOf(el: Element): { words: string; id: string | null } | null {
  const f = factsOf(el);
  return f && { words: wordList(f), id: f.assistId };
}

/** Номера строк, названные сотрудником (≥ 3 цифр, не больше 5). */
function rowsOf(v: unknown): string[] {
  return Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string' && ROW.test(x))
        .slice(0, 5)
    : [];
}

/** Строка таблицы с одним из названных номеров (целым словом). */
function rowNamed(row: Element, rows: string[]): boolean {
  if (!rows.length) return false;
  const text = ` ${(row.textContent || '').replace(/[^0-9]+/g, ' ')} `;
  return rows.some((n) => text.indexOf(` ${n} `) >= 0);
}

export function start(host: ActHost): ActApi {
  let refs = new Map<string, Element>();
  let deny: string[] = [];
  let allow: string[] = [];
  let runner: Runner | null = null;
  /** Сессия мастера: регистратор попыток и (рабочий хост) глушение отправок. */
  let armed = false;
  let work = false;
  /** Идёт план МАСТЕРА (`ui-run` с `vt`): после отчёта — обычные планы. */
  let vtRun = false;
  let check: Promise<ActApi | null> | null = null;

  const attempt = (el: Element | null) =>
    host.post({
      type: 'ui-attempt',
      n: 1,
      text: el ? maskLabel(visibleText(el).trim()).slice(0, 80) : '',
    } as never);

  // Вторая линия: нативный клик по цели «никогда» не уходит никогда.
  const nativeClick = host.N.click;
  const N: ActNatives = {
    ...host.N,
    click(this: HTMLElement) {
      const w = wordsOf(this);
      if (!w || neverTarget(w.words, w.id) || adminNever(this, w.words)) {
        if (armed) attempt(this);
        return;
      }
      if (nativeClick) nativeClick.call(this);
      else HTMLElement.prototype.click.call(this);
    },
  };

  class AdminRunner extends Runner {
    _refusal(step: UiStep, el: Element): string | null {
      let r = super._refusal(step, el);
      if (!r && step.kind !== 'fill' && step.kind !== 'select') {
        const w = wordsOf(el);
        if (w && adminNever(el, w.words)) r = 'danger';
      }
      // Сервер пропустил к исполнению шаг по запрещённой цели — дефект.
      if (armed && r && FORBIDDEN.has(r) && ACTION.has(step.kind)) attempt(el);
      return r;
    }
    // №91: вторая линия перед каждым событием нажатия — и правила «Админки».
    _never(el: Element): string | null {
      let r = super._never(el);
      const w = r ? null : wordsOf(el);
      if (w && adminNever(el, w.words)) r = 'danger';
      if (armed && r) attempt(el);
      return r;
    }
  }

  // Рабочий хост мастера: отправка формы во время плана — заглушить.
  const muted = () => armed && work && vtRun && !!runner && !runner._halt;
  const onSubmit = (e: Event) => {
    if (!muted()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    host.post({ type: 'vt-submit', n: 1 } as never);
  };
  // `form.submit()` (автосохранение в `onchange` поля) события `submit` не
  // шлёт — на время плана мастера на рабочем хосте глушится и он.
  const armSubmit = () => {
    const P = HTMLFormElement.prototype;
    const orig = P.submit;
    P.submit = function (this: HTMLFormElement) {
      if (muted()) host.post({ type: 'vt-submit', n: 1 } as never);
      else orig.call(this);
    };
  };

  // Р-З9-22: рабочий хост мастера — запись по сети из обработчика
  // синтетического события (автосохранение `fetch`/XHR/`sendBeacon` в
  // `change`) глушится: с `dispatched` шага до 1 с после его итога/стопа.
  // GET/HEAD — чтение, проходят; клик сотрудника вне окна — его действие.
  let netUntil = 0;
  const netMuted = () => {
    if (!armed || !work || !vtRun) return false;
    if (netUntil === Infinity && (!runner || runner._halt))
      netUntil = Date.now() + 1000;
    return Date.now() < netUntil;
  };
  const netBlocked = (method: unknown) => {
    const m = String(method || 'GET').toUpperCase();
    if (m === 'GET' || m === 'HEAD' || !netMuted()) return false;
    host.post({ type: 'vt-submit', n: 1 } as never);
    return true;
  };
  const armNet = () => {
    const w = window;
    const f = w.fetch;
    if (f)
      w.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
        const m =
          (init && init.method) ||
          (input instanceof Request ? input.method : 'GET');
        return netBlocked(m)
          ? Promise.reject(new TypeError('Failed to fetch'))
          : f.call(w, input, init);
      };
    const X = XMLHttpRequest.prototype;
    const open = X.open;
    const send = X.send;
    const verb = new WeakMap<XMLHttpRequest, string>();
    X.open = function (this: XMLHttpRequest, m: string) {
      verb.set(this, m);
      // eslint-disable-next-line prefer-rest-params
      return open.apply(this, arguments as never);
    } as typeof X.open;
    X.send = function (
      this: XMLHttpRequest,
      b?: Document | XMLHttpRequestBodyInit | null
    ) {
      if (netBlocked(verb.get(this)))
        throw new DOMException('blocked', 'NetworkError');
      return send.call(this, b);
    };
    const nav = navigator;
    const beacon = nav.sendBeacon;
    if (beacon)
      nav.sendBeacon = function (u: string | URL, d?: BodyInit | null) {
        return netBlocked('POST') ? false : beacon.call(nav, u, d);
      };
  };

  // Страница уходит в bfcache: раннер стоп без отчёта (иначе при «Назад»
  // оживёт посреди чужого плана); флаг «план идёт» — для следующей страницы.
  N.on(window, 'pagehide', (e) => {
    if ((e as PageTransitionEvent).persisted && runner) runner._stop(null, 1);
  });

  const snap = (rows: string[]) => {
    const s = takeSnapshot(deny, allow);
    const drop = new Set<string>();
    s.refs.forEach((el, ref) => {
      if (el.getAttribute('data-assist-id')) return;
      // Строки таблиц и гридов, а вне навигации — и пункты списков (карточки
      // клиентов `li`/`listitem`): ПД не уходят на сервер (Р-Э6б-6).
      const row =
        closestDeep(el, 'tr,[role=row],[role=gridcell],[role=cell]') ||
        (closestDeep(
          el,
          'nav,[role=navigation],[role=menu],[role=menubar],[role=tablist],header,aside'
        )
          ? null
          : closestDeep(el, 'li,[role=listitem]'));
      if (row && !rowNamed(row, rows)) drop.add(ref);
    });
    for (const ref of drop) s.refs.delete(ref);
    s.snapshot.elements = s.snapshot.elements.filter((e) => !drop.has(e.ref));
    // Подпись иконки внутри цели — серверу (стоп-лист «никогда» её увидит).
    for (const e of s.snapshot.elements) {
      const el = s.refs.get(e.ref);
      const inner = el ? innerLabels(el) : '';
      if (inner && (adminWords(inner) || neverTarget(inner, null)))
        e.hiddenLabel = maskLabel(
          ((e.hiddenLabel || '') + ' ' + inner).trim()
        ).slice(0, 80);
    }
    refs = s.refs;
    return s.snapshot;
  };

  return {
    on(raw) {
      const t = raw.type;
      if (t === 'vt-arm') {
        if (!armed) {
          N.on(document, 'submit', onSubmit, true);
          armSubmit();
          armNet();
        }
        armed = true;
        work = raw.work === true;
        return;
      }
      if (t === 'vt-env' || t === 'vt-markup' || t === 'vt-mark') {
        check ||= import(
          /* @vite-ignore */ new URL('check.js', import.meta.url).href
        )
          .then((x: { start: (h: ActHost) => ActApi }) => x.start(host))
          .catch(() => null);
        void check.then((c) => c && c.on(raw));
        return;
      }
      if (t === 'ui-undo')
        return void import(
          /* @vite-ignore */ new URL('undo.js', import.meta.url).href
        ).then((x: { undo: (r: unknown, m: unknown, h: ActHost) => void }) =>
          x.undo(raw, mem, host)
        );
      const m = parseUiCommand(raw);
      if (!m) return;
      switch (m.type) {
        case 'ui-snap':
          deny = m.deny;
          allow = m.allow;
          host.post({
            type: 'ui-snapshot',
            rid: m.rid,
            snapshot: snap(rowsOf(raw.rows)),
          });
          return;
        case 'ui-run': {
          // Как в act.js: повтор `ui-run` того же плана, пока раннер жив
          // (двойное «Да»), — не второй исполнитель поверх первого.
          if (runner && !runner._halt) {
            if (runner._plan == m.planId) return;
            if (netUntil === Infinity) netUntil = Date.now() + 1000;
            runner._stop(null);
          }
          vtRun = raw.vt === true;
          const r = new AdminRunner(
            {
              N,
              _refs: refs,
              _deny: deny,
              _allow: allow,
              _min: host.min,
              _mark: host.mark,
              _report: (index, result, reason, ms) => {
                // Окно глушения сети (Р-З9-22): шаг с эффектом начат — до
                // его итога и ещё 1 с (отложенное автосохранение).
                netUntil =
                  result == 'dispatched'
                    ? Infinity
                    : netUntil === Infinity
                      ? Date.now() + 1000
                      : netUntil;
                host.post({
                  type: 'ui-step',
                  planId: m.planId,
                  index,
                  result,
                  reason,
                  url: location.href.split('#')[0],
                  ms,
                });
              },
              _stopped: (by) => {
                if (netUntil === Infinity) netUntil = Date.now() + 1000;
                host.post({ type: 'ui-stopped', planId: m.planId, by });
              },
              _need: (index) =>
                host.post({ type: 'ui-need', planId: m.planId, index }),
            },
            m.planId,
            m.steps,
            m.from,
            m.lang
          );
          runner = r;
          void r._run(m.steps[m.from]?.state == 'dispatched');
          return;
        }
        case 'ui-ack':
          if (runner && runner._plan === m.planId) runner._ack(m.index);
          return;
        case 'ui-stop':
          if (netUntil === Infinity) netUntil = Date.now() + 1000;
          if (runner && runner._plan === m.planId) runner._stop(null);
          return;
        case 'ui-pause':
          if (runner) runner._pause(m.on);
          return;
      }
    },
  };
}
