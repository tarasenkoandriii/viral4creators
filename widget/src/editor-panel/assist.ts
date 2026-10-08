/**
 * №113 (заход 10) — подсказки панели редактора голосовой карты: ленивый
 * ES-модуль `/v1/editor-assist.js` своего origin `we.` (бюджет панели
 * `editor-panel` не растёт; панель берёт его `import()` только по вкладкам
 * «Промахи»/«Пропозиції» или кнопке «✨ Синоніми від ШІ» в карточке цели).
 * ТЗ помощника §5-кватер.4 «Предложения ИИ», §5-кватер.10:
 *
 *  - «Промахи» (`GET /editor/v1/misses`): Т-4 за 7 дней по целям этой
 *    страницы («натисніть самі», «не туди», «ціль не знайдено», «промах
 *    карти») с «Показати» и список «просили, не знайшли» (маскированные
 *    команды на этом шаблоне, разные відвідувачі) с «Прив’язати до елемента»
 *    — клик по сайту делает фразу синонимом (тот же путь, что «не те →
 *    вибрати» в «Перевірці»);
 *  - «Пропозиції»: ИИ-синонимы целей страницы (`suggested` в черновике) —
 *    ✓ принять / ✕ відхилити, и карточки очереди (`GET /editor/v1/suggestions`):
 *    «відвідувачі казали…» → прив’язати, «синтетичний клік не спрацьовує» →
 *    відкрити ціль; відхилене не повертається 30 днів
 *    (`POST /editor/v1/suggestions/mute`);
 *  - карточка цели: «✨ Запропонувати» (`POST /editor/v1/suggest-synonyms`,
 *    бюджет обучения; публикуются только принятые человеком, Р-33).
 * Черновик меняет только клик человека здесь (`isTrusted`, `human` панели).
 * Ванильный TS без HTML-приёмников (CSP iframe — Trusted Types 'none').
 */
import type { PanelLang } from './i18n';

type Syn = { text: string; origin: string };

export interface AssistTarget {
  key: string;
  status: string;
  names: Partial<Record<PanelLang, string>>;
  synonyms: Partial<Record<PanelLang, Syn[]>>;
  descriptor: { text: string };
}

export interface AssistCtx {
  h(
    tag: string,
    attrs?: Record<string, string | boolean | ((e: Event) => void)>,
    ...kids: Array<Node | string | null | false>
  ): HTMLElement;
  human(fn: () => void): (e: Event) => void;
  api<T>(path: string, init?: RequestInit): Promise<T>;
  ops(
    list: unknown[],
    inverse: unknown[] | null,
    label: string
  ): Promise<boolean>;
  /** Перечитать черновик (после ИИ-синонимов). */
  reload(): Promise<void>;
  render(): void;
  /** Карточка цели карты + рамка пикера. */
  open(key: string): void;
  /** Следующий клик по сайту — цель, фраза — её синоним (на языке `lang`). */
  bind(phrase: string, lang?: string | null): void;
  note(s: string): void;
  fail(e: unknown): void;
  lang(): PanelLang;
  path(): string;
  map(): { revision: number; targets: AssistTarget[] } | null;
}

export interface AssistApi {
  view(tab: 'miss' | 'sugg'): HTMLElement;
  card(t: AssistTarget): HTMLElement;
}

interface MissItem {
  key: string;
  self: number;
  notFound: number;
  wrong: number;
  missed: number;
  done: number;
}
interface Asked {
  id: string;
  phrase: string;
  lang: string | null;
  count: number;
  visitors: number;
  key: string | null;
}
interface MissesView {
  days: number;
  path: string;
  items: MissItem[];
  asked: Asked[];
}
type Card =
  | {
      id: string;
      kind: 'asked';
      phrase: string;
      lang: string | null;
      visitors: number;
      key: string | null;
    }
  | { id: string; kind: 'self'; key: string; count: number };

const TX = {
  uk: {
    days: 'За {d} днів, ціль цієї сторінки:',
    none: 'Промахів немає.',
    self: 'натисніть самі',
    wrong: 'не туди',
    notFound: 'ціль не знайдено',
    missed: 'промах карти',
    show: 'Показати',
    asked: 'Просили, не знайшли',
    askedRow: '«{p}» · відвідувачів: {v} ({n})',
    bind: 'Прив’язати до елемента',
    bindHint: 'Клікніть елемент на сторінці — «{p}» стане його синонімом.',
    ai: 'Пропозиції ШІ',
    aiNone: 'Пропозицій ШІ немає.',
    suggest: '✨ Запропонувати',
    suggested: 'Запропоновано: {n}. Публікуються лише прийняті.',
    accept: 'Прийняти',
    acceptAll: 'Прийняти всі',
    reject: 'Відхилити',
    open: 'Відкрити ціль',
    queue: 'З черги навчання',
    sAsked:
      'Відвідувачі ({v}) казали «{p}» і не знайшли — прив’язати до елемента?',
    sSelf:
      '«{k}»: синтетичний клік тут не спрацьовує (×{n}) — позначте «тільки підсвітка» або дайте розмітку розробнику.',
    sNone: 'Пропозицій немає.',
    muted: 'Не пропонуватиму 30 днів.',
    err: 'Не завантажилось.',
    retry: 'Повторити',
  },
  ru: {
    days: 'За {d} дней, цели этой страницы:',
    none: 'Промахов нет.',
    self: 'нажмите сами',
    wrong: 'не туда',
    notFound: 'цель не найдена',
    missed: 'промах карты',
    show: 'Показать',
    asked: 'Просили, не нашли',
    askedRow: '«{p}» · посетителей: {v} ({n})',
    bind: 'Привязать к элементу',
    bindHint: 'Кликните элемент на странице — «{p}» станет его синонимом.',
    ai: 'Предложения ИИ',
    aiNone: 'Предложений ИИ нет.',
    suggest: '✨ Предложить',
    suggested: 'Предложено: {n}. Публикуются только принятые.',
    accept: 'Принять',
    acceptAll: 'Принять все',
    reject: 'Отклонить',
    open: 'Открыть цель',
    queue: 'Из очереди обучения',
    sAsked:
      'Посетители ({v}) говорили «{p}» и не нашли — привязать к элементу?',
    sSelf:
      '«{k}»: синтетический клик здесь не срабатывает (×{n}) — отметьте «только подсветка» или дайте разметку разработчику.',
    sNone: 'Предложений нет.',
    muted: 'Не буду предлагать 30 дней.',
    err: 'Не загрузилось.',
    retry: 'Повторить',
  },
  en: {
    days: 'Last {d} days, targets of this page:',
    none: 'No misses.',
    self: 'press it yourself',
    wrong: 'wrong target',
    notFound: 'target not found',
    missed: 'map miss',
    show: 'Show',
    asked: 'Asked, not found',
    askedRow: '“{p}” · visitors: {v} ({n})',
    bind: 'Bind to an element',
    bindHint: 'Click an element on the page — “{p}” becomes its synonym.',
    ai: 'AI suggestions',
    aiNone: 'No AI suggestions.',
    suggest: '✨ Suggest',
    suggested: 'Suggested: {n}. Only accepted ones get published.',
    accept: 'Accept',
    acceptAll: 'Accept all',
    reject: 'Reject',
    open: 'Open target',
    queue: 'From the learning queue',
    sAsked: 'Visitors ({v}) said “{p}” and found nothing — bind to an element?',
    sSelf:
      '“{k}”: a synthetic click does not work here (×{n}) — mark it “highlight only” or give the developer markup.',
    sNone: 'No suggestions.',
    muted: 'Will not suggest for 30 days.',
    err: 'Failed to load.',
    retry: 'Retry',
  },
};

const fmt = (s: string, v: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ''));

export function start(c: AssistCtx): AssistApi {
  const { h, human } = c;
  const L = () => TX[c.lang()] || TX.uk;
  let misses: MissesView | null = null;
  let cards: Card[] | null = null;
  /** Для какой страницы и ревизии черновика загружены данные. */
  let seenM = '';
  let seenC = '';
  let busy = '';
  /**
   * Аудит Ж (P2-1): сбой загрузки — для этой страницы/ревизии и вкладки
   * запоминается; перерисовка его не перезапрашивает (иначе панель засыпала
   * бы сервер), повтор — только кнопкой «Повторити».
   */
  const failed = { misses: '', suggestions: '' };
  let tab = '';
  const at = () => `${c.path()}#${c.map()?.revision ?? 0}`;

  const load = (kind: 'misses' | 'suggestions') => {
    const where = at();
    const k = kind + where;
    if (busy === k) return;
    busy = k;
    c.api<{ items: Card[] }>(
      `/editor/v1/${kind}?path=${encodeURIComponent(c.path())}`
    )
      .then((v) => {
        if (kind === 'misses') {
          misses = v as unknown as MissesView;
          seenM = where;
        } else {
          cards = v.items;
          seenC = where;
        }
      })
      .catch((e) => {
        failed[kind] = where;
        c.fail(e);
      })
      .finally(() => {
        busy = '';
        c.render();
      });
  };
  const fresh = () => {
    seenM = seenC = '';
  };
  const btn = (label: string, fn: () => void, cls = '') =>
    h('button', { type: 'button', class: cls, click: human(fn) }, label);
  /** Нет данных: загрузка (один раз) или сбой с «Повторити». */
  const pending = (box: HTMLElement, kind: 'misses' | 'suggestions') => {
    if (failed[kind] === at())
      box.append(
        h('p', { class: 'warn' }, L().err),
        btn(L().retry, () => {
          failed[kind] = '';
          load(kind);
        })
      );
    else {
      load(kind);
      box.append(h('p', { class: 'hint' }, '…'));
    }
    return box;
  };
  const nameOf = (key: string) => {
    const t = c.map()?.targets.find((x) => x.key === key);
    return (t && (t.names[c.lang()] || t.descriptor.text)) || key;
  };

  /** Синонимы цели с заменой: `fn` → новый список или null (убрать). */
  const patch = (
    t: AssistTarget,
    fn: (s: Syn, l: PanelLang) => Syn | null,
    label: string
  ) => {
    const synonyms: Partial<Record<PanelLang, Syn[]>> = {};
    for (const l of ['uk', 'ru', 'en'] as PanelLang[]) {
      const list = (t.synonyms[l] ?? [])
        .map((s) => fn(s, l))
        .filter((s): s is Syn => !!s);
      if (list.length) synonyms[l] = list;
    }
    return c.ops(
      [{ op: 'upsert-target', target: { key: t.key, synonyms } }],
      [{ op: 'upsert-target', target: t }],
      label
    );
  };
  const accept = (t: AssistTarget, one?: Syn) =>
    patch(
      t,
      (s) =>
        s.origin === 'suggested' && (!one || s === one)
          ? { text: s.text, origin: 'owner' }
          : s,
      t.key
    );
  const reject = async (t: AssistTarget, one: Syn, l: PanelLang) => {
    if (await patch(t, (s) => (s === one ? null : s), t.key))
      await c
        .api('/editor/v1/suggestions/mute', {
          method: 'POST',
          body: JSON.stringify({ key: t.key, lang: l, text: one.text }),
        })
        .catch(c.fail);
  };

  /** ИИ-синонимы цели (`suggested`): ✓ / ✕ на каждый, «прийняти всі». */
  const aiBox = (t: AssistTarget, title: boolean) => {
    const box = h('div', { class: 'ai' });
    let n = 0;
    for (const l of ['uk', 'ru', 'en'] as PanelLang[])
      for (const s of t.synonyms[l] ?? []) {
        if (s.origin !== 'suggested') continue;
        n++;
        box.append(
          h(
            'div',
            { class: 'row' },
            `«${s.text}» · ${l}`,
            btn('✓', () => void accept(t, s)),
            btn('✕', () => void reject(t, s, l))
          )
        );
      }
    if (n > 1) box.append(btn(L().acceptAll, () => void accept(t)));
    if (n && title)
      box.prepend(h('p', { class: 'cnt' }, `${nameOf(t.key)} · ${t.key}`));
    return n ? box : null;
  };

  const missView = () => {
    const box = h('div', {});
    if (!misses || seenM !== at()) return pending(box, 'misses');
    const T = L();
    box.append(h('p', { class: 'cnt' }, fmt(T.days, { d: misses.days })));
    if (!misses.items.length && !misses.asked.length)
      box.append(h('p', { class: 'hint' }, T.none));
    const ul = h('ul', { class: 'list' });
    for (const m of misses.items) {
      const parts = [
        m.self && `${T.self} ×${m.self}`,
        m.wrong && `${T.wrong} ×${m.wrong}`,
        m.notFound && `${T.notFound} ×${m.notFound}`,
        m.missed && `${T.missed} ×${m.missed}`,
      ].filter(Boolean);
      ul.append(
        h(
          'li',
          { class: 'red' },
          `${nameOf(m.key)} · ${m.key} — ${parts.join(' · ')} `,
          btn(T.show, () => c.open(m.key))
        )
      );
    }
    box.append(ul);
    if (misses.asked.length) {
      box.append(h('p', { class: 'cnt' }, T.asked));
      const ol = h('ul', { class: 'list' });
      for (const a of misses.asked)
        ol.append(
          h(
            'li',
            {},
            fmt(T.askedRow, { p: a.phrase, v: a.visitors, n: a.count }),
            ' ',
            btn(T.bind, () => {
              c.bind(a.phrase, a.lang);
              c.note(fmt(T.bindHint, { p: a.phrase }));
            })
          )
        );
      box.append(ol);
    }
    return box;
  };

  const suggView = () => {
    const T = L();
    const box = h('div', {});
    const m = c.map();
    box.append(h('p', { class: 'cnt' }, T.ai));
    let ai = 0;
    for (const t of m?.targets ?? []) {
      if (t.status !== 'active') continue;
      const b = aiBox(t, true);
      if (b) {
        ai++;
        box.append(b);
      }
    }
    if (!ai) box.append(h('p', { class: 'hint' }, T.aiNone));
    box.append(h('p', { class: 'cnt' }, T.queue));
    if (!cards || seenC !== at()) return pending(box, 'suggestions');
    if (!cards.length) box.append(h('p', { class: 'hint' }, T.sNone));
    const mute = (id: string) => async () => {
      try {
        await c.api('/editor/v1/suggestions/mute', {
          method: 'POST',
          body: JSON.stringify({ id }),
        });
        c.note(T.muted);
        fresh();
      } catch (e) {
        c.fail(e);
      }
      c.render();
    };
    for (const k of cards)
      box.append(
        h(
          'div',
          { class: 'card' },
          h(
            'p',
            {},
            k.kind === 'asked'
              ? fmt(T.sAsked, { v: k.visitors, p: k.phrase })
              : fmt(T.sSelf, { k: nameOf(k.key), n: k.count })
          ),
          h(
            'div',
            { class: 'acts' },
            k.kind === 'asked'
              ? btn(
                  T.bind,
                  () => {
                    c.bind(k.phrase, k.lang);
                    c.note(fmt(T.bindHint, { p: k.phrase }));
                  },
                  'pri'
                )
              : btn(T.open, () => c.open(k.key), 'pri'),
            btn(T.reject, () => void mute(k.id)())
          )
        )
      );
    return box;
  };

  return {
    view(t) {
      // Другая вкладка — прежние сбои можно попробовать снова.
      if (t !== tab) failed.misses = failed.suggestions = '';
      tab = t;
      return t === 'miss' ? missView() : suggView();
    },
    card(t) {
      const T = L();
      const box = h('fieldset', { class: 'ai' }, h('legend', {}, T.ai));
      const b = aiBox(t, false);
      if (b) box.append(b);
      box.append(
        btn(T.suggest, async () => {
          const m = c.map();
          if (!m) return;
          try {
            const r = await c.api<{ kept: Record<string, number> }>(
              '/editor/v1/suggest-synonyms',
              {
                method: 'POST',
                body: JSON.stringify({
                  expectedRevision: m.revision,
                  key: t.key,
                }),
              }
            );
            const n = Object.values(r.kept).reduce((a, x) => a + x, 0);
            c.note(fmt(T.suggested, { n }));
            await c.reload();
          } catch (e) {
            c.fail(e);
          }
        })
      );
      return box;
    },
  };
}
