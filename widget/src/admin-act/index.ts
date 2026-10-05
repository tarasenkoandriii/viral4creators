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
 *    исполняется НИКОГДА: и проверкой исполнителя, и обёрткой нативного
 *    `click` (вторая линия); в сессии мастера (`vt-arm`) каждая такая
 *    попытка — сообщение `ui-attempt` (регистратор: попытка > 0 — провал);
 *  - мастер на РАБОЧЕМ хосте (`vt-arm` с `work`): отправка формы во время
 *    плана глушится (`submit` в фазе перехвата) и регистрируется `vt-submit`;
 *  - окружение и разметка мастера — чанк `check.js`, возврат полей —
 *    `undo.js` (оба рядом, тот же выпуск).
 *
 * Исполняется в origin заказчика: никаких HTML-приёмников, никаких
 * запросов, кроме своих чанков; только сообщения своему iframe.
 */
import type { ActApi, ActHost } from '../act';
import { mem, Runner, type ActNatives } from '../act/exec';
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
  /(?<!\p{L})(скасувати|скасуйте|скасуй|відмінити|відмініть|відміна|отменить|отмените|отмени|отмена|аннулировать|аннулируйте|анулювати|анулюйте|cancel|void)(?!\p{L})/iu,
  /(?<!\p{L})(повернути|поверніть|поверни|вернуть|верните|верни|return)(?!\p{L})(?!\s+(?:to|back|до|к|назад)(?!\p{L}))/iu,
  /(?<!\p{L})(trash|destroy|purge)(?!\p{L})/iu,
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
  if (!f) return null;
  return {
    words: [
      f.text,
      f.hiddenLabel || '',
      (f.assistId || '').replace(/[-_.:]+/g, ' '),
    ].join(' '),
    id: f.assistId,
  };
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
    liveRefusal(step: UiStep, el: Element): string | null {
      let r = super.liveRefusal(step, el);
      if (!r && step.kind !== 'fill' && step.kind !== 'select') {
        const w = wordsOf(el);
        if (w && adminNever(el, w.words)) r = 'danger';
      }
      // Сервер пропустил к исполнению шаг по запрещённой цели — дефект.
      if (armed && r && FORBIDDEN.has(r) && ACTION.has(step.kind)) attempt(el);
      return r;
    }
  }

  // Рабочий хост мастера: отправка формы во время плана — заглушить.
  const muted = () => armed && work && !!runner && !runner.stopped;
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
          if (runner && !runner.stopped) runner.stop(null);
          const r = new AdminRunner(
            {
              N,
              refs,
              deny,
              allow,
              min: host.min,
              mark: host.mark,
              report: (index, result, reason, ms) =>
                host.post({
                  type: 'ui-step',
                  planId: m.planId,
                  index,
                  result,
                  reason,
                  url: location.href.split('#')[0],
                  ms,
                }),
              stopped: (by) =>
                host.post({ type: 'ui-stopped', planId: m.planId, by }),
              need: (index) =>
                host.post({ type: 'ui-need', planId: m.planId, index }),
            },
            m.planId,
            m.steps,
            m.from,
            m.lang
          );
          runner = r;
          void r.run(m.steps[m.from] && m.steps[m.from].state === 'dispatched');
          return;
        }
        case 'ui-ack':
          if (runner && runner.planId === m.planId) runner.ack(m.index);
          return;
        case 'ui-stop':
          if (runner && runner.planId === m.planId) runner.stop(null);
          return;
        case 'ui-pause':
          if (runner) runner.pause(m.on);
          return;
      }
    },
  };
}
