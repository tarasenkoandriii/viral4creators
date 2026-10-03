/**
 * Ленивый чанк связанного режима `dist/v1/ana.js` (Э3-бис; ТЗ §5-тер.2,
 * §5-тер.9, Р-47). Грузит его чанк engage.js, только если в конфиге сайта
 * есть поле `analytics` (владелец включил связанный режим, тариф позволяет).
 *
 * Согласие:
 *  - решение баннера сайта — `V4CAssist('consent', { analytics })`; если
 *    владелец включил, ещё и Google Consent Mode v2 (`analytics_storage`
 *    в dataLayer, опрос 60 с — свой обработчик в dataLayer не вешаем);
 *  - GPC/DNT — «без согласия» всегда, даже при consent(true) (В-46);
 *  - БЕЗ согласия на устройство ничего не пишется и с него не читается для
 *    аналитики (кроме проверки собственного ключа, чтобы удалить его при
 *    GPC/отказе), на сервер ничего не уходит;
 *  - С согласием: ключ визита `<префикс>:<pk>:v` в localStorage страницы
 *    (случайный, 30 дней), счётчик `visit_new`, ключ — iframe (связь
 *    диалога с визитом) и в маяки целей; эксперимент; поведение (bf.js);
 *  - отзыв (`consent(false)`) — ключ удаляется сразу, iframe получает
 *    `v: null`, поведение останавливается.
 * Эксперимент (только с согласием): группа — FNV-1a от `соль:ключ` (сервер
 * считает так же и не верит клиенту); holdout b — виджет скрыт (кнопка и
 * сигналы), варианты — тексты B в iframe; включение — маяком `/widget/v1/exp`
 * (holdout — сразу, варианты — при первом открытии чата).
 * `V4CAssist('group', cb)` → cb('w'|'h'|null); `V4CAssist('ref', cb)` →
 * cb(ссылка для вебхука заказа | null) — без согласия всегда null.
 * Тот же запрет, что у загрузчика: без HTML-приёмников и eval.
 */
import type { AnaApi, EngageHost, GoalMsg } from '../engage/host';
import { armOf, doNotTrack, gcmAnalytics, parseAna } from '../shared/ana';
import { WIDGET_BF_PATH, WIDGET_STORAGE_PREFIX } from '../shared/brand';
import { isObj } from '../shared/config';

const DAY = 864e5;
const TTL = 30 * DAY;
const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function newKey(): string {
  let s = 'v';
  for (const b of crypto.getRandomValues(new Uint8Array(20)))
    s += (b & 63).toString(36);
  return s;
}

export function start(h: EngageHost, queue: unknown[][]): AnaApi {
  const N = h.N;
  const cfg = parseAna(h.cfg.rawAna);
  const key = `${WIDGET_STORAGE_PREFIX}:${h.pk}:v`;
  const nav = navigator as Navigator & { globalPrivacyControl?: unknown };
  const dnt = doNotTrack(nav, window as Partial<{ doNotTrack: unknown }>);
  let visit: string | null = null;
  let on = false;
  let hid = false;
  let enrolled = false;
  let bfStop: (() => void) | null = null;
  const api = (p: string) => h.origin + '/widget/v1/' + p;

  const read = (): string | null => {
    const raw = store()?.getItem(key) || '';
    const [v, exp] = raw.split('.');
    return KEY_RE.test(v) && Number(exp) > Date.now() ? v : null;
  };
  const drop = () => {
    try {
      store()?.removeItem(key);
    } catch {
      /* нечего удалять */
    }
  };

  const exp = cfg && cfg.exp;
  const arm = () => (exp && visit ? armOf(exp.salt, visit, exp.share) : null);
  const enroll = () => {
    if (enrolled || !exp || !visit) return;
    enrolled = true;
    N.beacon(api('exp'), JSON.stringify({ pk: h.pk, x: exp.id, v: visit }));
  };
  const toFrame = () => {
    const b = arm() === 'b';
    h.post({
      type: 'ana',
      visit,
      greeting: b && exp ? exp.greeting : null,
      suggestions: b && exp ? exp.suggestions : null,
    });
  };

  // Цели из загрузчика — с ключом визита (только при согласии).
  const send = h.sendGoal.bind(h);
  (h as { sendGoal: (m: GoalMsg) => void }).sendGoal = (m) =>
    send(visit ? ({ ...m, visit } as GoalMsg) : m);

  function grant() {
    if (!cfg || dnt) return revoke();
    if (!visit) {
      visit = read();
      if (!visit) {
        visit = newKey();
        h.count('visit_new');
      }
      try {
        store()?.setItem(key, visit + '.' + (Date.now() + TTL));
      } catch {
        /* хранилище закрыто — визит только в памяти документа */
      }
    }
    if (on) return;
    on = true;
    toFrame();
    if (exp) {
      if (exp.kind == 'holdout') {
        if (arm() == 'b') {
          // Группа без виджета: ни кнопки, ни сигналов (§5-тер.2).
          hid = true;
          h.stop = true;
          h.call(['hide']);
        }
        enroll();
      } else if (h.ui && h.ui.isOpen()) enroll();
      else h.call(['on', 'open', enroll]);
    }
    if (cfg.behavior && !bfStop)
      import(/* @vite-ignore */ h.chunk(WIDGET_BF_PATH))
        .then((m: { start: (h: EngageHost, v: string) => () => void }) => {
          if (on && visit && !h.destroyed) bfStop = m.start(h, visit);
        })
        .catch(() => null);
  }

  function revoke() {
    const was = on || visit !== null;
    on = false;
    visit = null;
    // Новое согласие — новый ключ, новая единица (аудит Э3-бис).
    enrolled = false;
    drop();
    if (bfStop) bfStop();
    bfStop = null;
    if (hid) {
      hid = false;
      h.call(['show']);
    }
    if (was) toFrame();
  }

  const cb = (f: unknown, v: unknown) => {
    if (typeof f == 'function')
      h.later(() => {
        try {
          (f as (x: unknown) => void)(v);
        } catch {
          /* чужой колбэк не ломает виджет */
        }
      }, 0);
  };

  function call(args: unknown[]) {
    const [cmd, a] = args;
    if (cmd == 'consent') {
      if (isObj(a) && typeof a.analytics == 'boolean')
        a.analytics ? grant() : revoke();
    } else if (cmd == 'group') {
      const g = exp && exp.kind == 'holdout' && on ? arm() : null;
      cb(a, g ? (g == 'b' ? 'h' : 'w') : null);
    } else if (cmd == 'ref') {
      if (!on || !visit) return cb(a, null);
      N.fetch(api('ref'), {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        body: JSON.stringify({ pk: h.pk, v: visit }),
      })
        .then((r) => r.json())
        .then((j: unknown) =>
          cb(
            a,
            isObj(j) && isObj(j.data) && typeof j.data.ref == 'string'
              ? j.data.ref
              : null
          )
        )
        .catch(() => cb(a, null));
    }
  }

  // Старт: «не отслеживать» — ключ удаляется; ранее данное согласие (ключ
  // визита жив) — связанный режим сразу; GCM — если владелец включил.
  if (dnt) drop();
  else if (read()) grant();
  if (cfg && cfg.gcm && !dnt) {
    let left = 60;
    const poll = () => {
      const g = gcmAnalytics((window as { dataLayer?: unknown }).dataLayer);
      if (g === true && !on) grant();
      else if (g === false && on) revoke();
      if (--left > 0 && !h.destroyed) h.later(poll, 1000);
    };
    poll();
  }
  for (const q of queue) call(q);
  h.cleanups.push(() => bfStop && bfStop());
  return { call };
}
