/**
 * Ленивый чанк поведенческих факторов `dist/v1/bf.js` (Э3-бис; ТЗ §5-тер.8,
 * Р-46, К-11). Грузит его ana.js ТОЛЬКО при согласии посетителя на
 * аналитику и включённом у сайта поведении (Business+); без согласия не
 * существует. Итог просмотра — один маяк `POST /widget/v1/pv` при скрытии
 * вкладки (повтор при следующем скрытии — тот же pvId, сервер перезаписывает).
 *
 * НИКОГДА (К-11; линтер запрещает в этой папке слушатели клавиатуры и ввода
 * и чтение `.value`): значения полей, их длина, нажатия клавиш, буфер
 * обмена, выделения, координаты в отправке, записи сессий, отпечаток
 * (canvas/WebGL/шрифты/UA целиком/разрешение), click-id рекламы. Координаты
 * клика живут только в памяти (ярость-клик — «≥ 3 клика за 700 мс в радиусе
 * 30 px по одному элементу»), в итог идёт число.
 * Слушатели пассивные; геометрия прокрутки читается таймером раз в 2 с, не
 * в обработчике прокрутки; обработчик клика — константное время.
 */
import type { EngageHost } from '../engage/host';
import { fnv1a32, shiftOf } from '../shared/ana';
import { maskLabel } from '../shared/ui-plan';

type Num = number;

function rid(): string {
  let s = 'p';
  for (const b of crypto.getRandomValues(new Uint8Array(15)))
    s += (b & 63).toString(36);
  return s;
}

const FIELD = /^[A-Za-z0-9_.:[\]-]{1,30}$/;

export function start(h: EngageHost, visit: string): () => void {
  const N = h.N;
  const W = window;
  const D = document;
  const offs: Array<() => void> = [];
  const on = (t: EventTarget, type: string, fn: (e: Event) => void) => {
    N.on(t, type, fn as EventListener, { capture: true, passive: true });
    offs.push(() => N.off(t, type, fn as EventListener, true));
  };
  const nav = performance.getEntriesByType
    ? (performance.getEntriesByType('navigation')[0] as
        PerformanceNavigationTiming | undefined)
    : undefined;
  let first = true;
  let pv = rid();
  let path = location.pathname;
  let prev = '';
  try {
    const r = D.referrer && new URL(D.referrer);
    if (r && r.origin === location.origin) prev = r.pathname;
  } catch {
    /* без предыдущей страницы */
  }
  let t0 = Date.now();
  let act = 0;
  let lastAct = t0;
  let scroll = 0;
  let clicks = 0;
  let rage = 0;
  let errs = 0;
  let groups: Array<{ h: string; m: string; s: string }> = [];
  let fs = 0;
  let fb = 0;
  let fa = '';
  let fi = 0;
  let lcp: Num | null = null;
  let inp: Num | null = null;
  let cls = 0;
  let chat = 0;
  let burst: Array<[Num, Num, Num, EventTarget | null]> = [];
  let stopped = false;

  const reset = () => {
    first = false;
    pv = rid();
    t0 = Date.now();
    act = clicks = rage = errs = fs = fb = fi = chat = 0;
    groups = [];
    fa = '';
    lcp = inp = null;
    cls = 0;
    scroll = 0;
  };

  const sample = () => {
    const de = D.documentElement;
    const p = Math.min(
      100,
      Math.round(
        ((W.scrollY + W.innerHeight) / Math.max(1, de.scrollHeight)) * 100
      )
    );
    if (p > scroll) scroll = p;
  };

  const dev = () => {
    const coarse = W.matchMedia('(pointer: coarse)').matches;
    const w = W.innerWidth;
    return coarse && w < 768 ? 'm' : coarse && w < 1100 ? 't' : 'd';
  };

  const flush = () => {
    sample();
    const body: Record<string, unknown> = {
      pk: h.pk,
      pv,
      v: visit,
      p: path,
      d: dev(),
      sc: scroll,
      ac: Math.min(act, 18e5),
      to: Date.now() - t0,
      ck: clicks,
      rg: rage,
      er: errs,
      fs,
      fb,
      fi,
      bk: first && nav && nav.type === 'back_forward' ? 1 : 0,
      ch: chat,
      c: Math.round(cls * 1000) / 1000,
    };
    if (prev) body.pp = prev;
    if (fa && !fb) body.fa = fa;
    if (groups.length) body.eg = groups;
    if (lcp !== null) body.l = Math.round(lcp);
    if (inp !== null) body.i = Math.round(inp);
    if (first) {
      try {
        const r = D.referrer && new URL(D.referrer);
        if (r && r.origin !== location.origin) body.rh = r.hostname;
        const q = new URL(location.href).searchParams;
        const u = (k: string) => (q.get('utm_' + k) || '').slice(0, 60);
        if (u('source')) body.us = u('source');
        if (u('medium')) body.um = u('medium');
        if (u('campaign')) body.uc = u('campaign');
      } catch {
        /* без источника */
      }
    }
    N.beacon(h.origin + '/widget/v1/pv', JSON.stringify(body));
  };

  // Активность: видимая вкладка и действие за последние 15 с; раз в секунду.
  const mark = () => (lastAct = Date.now());
  for (const t of ['pointerdown', 'wheel', 'touchstart', 'scroll'])
    on(W, t, mark);
  let ticks = 0;
  const tick = () => {
    if (D.visibilityState === 'visible' && Date.now() - lastAct < 15e3)
      act += 1000;
    if (++ticks % 2 === 0) sample();
    // SPA: смена пути — итог прошлой страницы и новый просмотр.
    if (location.pathname !== path) {
      flush();
      prev = path;
      path = location.pathname;
      reset();
    }
    if (h.ui && h.ui.isOpen()) chat = 1;
    if (!stopped) N.later(tick, 1000);
  };

  on(D, 'click', (e) => {
    clicks++;
    const m = e as MouseEvent;
    const now = Date.now();
    burst = burst.filter((b) => now - b[0] < 700);
    burst.push([now, m.clientX, m.clientY, m.target]);
    const same = burst.filter(
      (b) =>
        b[3] === m.target &&
        Math.abs(b[1] - m.clientX) < 30 &&
        Math.abs(b[2] - m.clientY) < 30
    );
    if (same.length === 3) rage++;
  });

  on(W, 'error', (e) => {
    errs++;
    const ev = e as ErrorEvent;
    // Аудит 06.10: текст ошибки сайта бывает с ПД («user ivan@…», номер
    // карты/телефона, ключ в URL) — маскируем ДО хеша и отправки.
    const msg = maskLabel(String(ev.message || 'error')).slice(0, 120);
    const hh = fnv1a32(msg).toString(16);
    if (groups.length < 3 && !groups.some((g) => g.h === hh)) {
      let s = '';
      try {
        s = ev.filename ? new URL(ev.filename).hostname : '';
      } catch {
        s = '';
      }
      groups.push({ h: hh, m: msg, s });
    }
  });

  // Формы: только факт начала, имя поля ухода, отправка, ошибки валидации.
  on(D, 'focusin', (e) => {
    const t = e.target as Element | null;
    if (!t || !t.closest || !t.closest('form')) return;
    if (!/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
    fs = 1;
    const n = t.getAttribute('name') || t.getAttribute('id') || '';
    fa = FIELD.test(n) ? n : '';
  });
  on(W, 'submit', () => (fb = 1));
  on(D, 'invalid', () => fi++);

  const obs: PerformanceObserver[] = [];
  const watch = (
    type: string,
    fn: (e: PerformanceEntry) => void,
    x?: object
  ) => {
    try {
      const o = new PerformanceObserver((l) => l.getEntries().forEach(fn));
      o.observe({ type, buffered: true, ...x } as PerformanceObserverInit);
      obs.push(o);
    } catch {
      /* браузер не умеет — метрики нет */
    }
  };
  watch('largest-contentful-paint', (e) => (lcp = e.startTime));
  watch('layout-shift', (e) => (cls += shiftOf(e)));
  watch(
    'event',
    (e) => {
      if (inp === null || e.duration > inp) inp = e.duration;
    },
    { durationThreshold: 40 }
  );

  const onHide = () => D.visibilityState === 'hidden' && flush();
  on(D, 'visibilitychange', onHide);
  on(W, 'pagehide', flush);
  N.later(tick, 1000);
  return () => {
    stopped = true;
    for (const o of obs) o.disconnect();
    for (const f of offs.splice(0)) f();
  };
}
