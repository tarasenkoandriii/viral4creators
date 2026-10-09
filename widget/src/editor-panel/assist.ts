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
 *    бюджет обучения; публикуются только принятые человеком, Р-33);
 *  - заход 11 (остаток №113): тепловые значки «Промахов» на странице (`heat`
 *    → пикер; 🗣 просили · ✋ натисніть самі · ↩ не туди · ? не знайдено),
 *    «не туди» с командами и «Перепривязати» (клик по правильной цели —
 *    фраза станет её синонимом, со старой — снимется), карточки «вела не
 *    туди» и «термін розпізнавання» (`POST /editor/v1/suggestions/term` —
 *    термин в черновик; публикация — как обычно).
 * Черновик меняет только клик человека здесь (`isTrusted`, `human` панели).
 * Ванильный TS без HTML-приёмников (CSP iframe — Trusted Types 'none').
 */
import { phraseNorm, type HeatItem } from '../shared/editor-protocol';
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
  /**
   * Следующий клик по сайту — цель, фраза — её синоним (на языке `lang`);
   * `from` (заход 11) — цель «не туди»: с неё фраза снимается.
   */
  bind(phrase: string, lang?: string | null, from?: string): void;
  note(s: string): void;
  fail(e: unknown): void;
  lang(): PanelLang;
  path(): string;
  map(): { revision: number; targets: AssistTarget[] } | null;
}

export interface AssistApi {
  view(tab: 'miss' | 'sugg'): HTMLElement;
  card(t: AssistTarget): HTMLElement;
  /** (заход 11) Тепловые значки целей страницы (пусто — данных ещё нет). */
  heat(): HeatItem[];
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
interface Wrong {
  id: string;
  key: string;
  phrase: string;
  lang: string | null;
  count: number;
  visitors: number;
}
interface MissesView {
  days: number;
  path: string;
  items: MissItem[];
  asked: Asked[];
  /** (заход 11) Старый сервер — полей нет. */
  heat?: MissItem[];
  wrong?: Wrong[];
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
  | {
      id: string;
      kind: 'wrong';
      key: string;
      phrase: string;
      lang: string | null;
      visitors: number;
    }
  | { id: string; kind: 'term'; phrase: string; visitors: number }
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
    legend:
      'Значки на сторінці: 🗣 просили · ✋ натисніть самі · ↩ не туди · ? не знайдено',
    wrongRow: '↩ «{p}» · відвідувачів: {v} ({n})',
    rebind: 'Перепривязати',
    rebindHint:
      'Клікніть правильний елемент — «{p}» стане його синонімом (з «{k}» — знімемо).',
    sWrong:
      '«{p}» вела на «{k}», а відвідувачі ({v}) одразу зупиняли — перепривязати?',
    sTerm:
      'Розпізнавання не впевнене в «{p}» (відвідувачів: {v}) — додати до словника термінів?',
    addTerm: 'Додати термін',
    nameClash:
      'Увага: «{p}» — це назва цілі «{k}». Після перепривязки публікацію зупинить конфлікт фраз — спершу перейменуйте «{k}».',
    rename: 'Перейменувати «{k}»',
    termAdded: '«{p}» — у термінах чернетки; запрацює після публікації.',
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
    legend:
      'Значки на странице: 🗣 просили · ✋ нажмите сами · ↩ не туда · ? не найдено',
    wrongRow: '↩ «{p}» · посетителей: {v} ({n})',
    rebind: 'Перепривязать',
    rebindHint:
      'Кликните правильный элемент — «{p}» станет его синонимом (с «{k}» — снимем).',
    sWrong:
      '«{p}» вела на «{k}», а посетители ({v}) сразу останавливали — перепривязать?',
    sTerm:
      'Распознавание не уверено в «{p}» (посетителей: {v}) — добавить в словарь терминов?',
    addTerm: 'Добавить термин',
    nameClash:
      'Внимание: «{p}» — это название цели «{k}». После перепривязки публикацию остановит конфликт фраз — сначала переименуйте «{k}».',
    rename: 'Переименовать «{k}»',
    termAdded: '«{p}» — в терминах черновика; заработает после публикации.',
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
    legend:
      'Page badges: 🗣 asked · ✋ press it yourself · ↩ wrong target · ? not found',
    wrongRow: '↩ “{p}” · visitors: {v} ({n})',
    rebind: 'Rebind',
    rebindHint:
      'Click the right element — “{p}” becomes its synonym (removed from “{k}”).',
    sWrong:
      '“{p}” led to “{k}” and visitors ({v}) stopped it at once — rebind?',
    sTerm:
      'Speech recognition is unsure about “{p}” (visitors: {v}) — add it to the terms dictionary?',
    addTerm: 'Add term',
    nameClash:
      'Note: “{p}” is the name of target “{k}”. After rebinding, a phrase conflict will block publishing — rename “{k}” first.',
    rename: 'Rename “{k}”',
    termAdded: '“{p}” is in the draft terms; it works after publishing.',
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

  /**
   * Аудит P2-3: фраза — ИМЯ старой цели (а не синоним): перепривязка
   * оставит конфликт фраз, и ворота остановят публикацию — предупреждение
   * до клика и «Перейменувати» (карточка старой цели).
   */
  const clash = (w: { phrase: string; key: string }) => {
    const a = c.map()?.targets.find((x) => x.key === w.key);
    const n = phraseNorm(w.phrase);
    if (
      !a ||
      !n ||
      !Object.values(a.names).some((x) => x && phraseNorm(x) === n)
    )
      return null;
    const T = L();
    return h(
      'p',
      { class: 'warn' },
      fmt(T.nameClash, { p: w.phrase, k: nameOf(w.key) }),
      ' ',
      btn(fmt(T.rename, { k: nameOf(w.key) }), () => c.open(w.key))
    );
  };
  /** Заход 11: «не туди» → клик по правильной цели (фраза — её синоним). */
  const rebind = (w: { phrase: string; lang: string | null; key: string }) => {
    // Подсказка — до `bind` (он перерисовывает панель).
    c.note(fmt(L().rebindHint, { p: w.phrase, k: nameOf(w.key) }));
    c.bind(w.phrase, w.lang, w.key);
  };
  /** Принять термин распознавания: сервер берёт текст по id (не панель). */
  const addTerm = async (k: { id: string; phrase: string }) => {
    const m = c.map();
    if (!m) return;
    try {
      await c.api('/editor/v1/suggestions/term', {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: m.revision, id: k.id }),
      });
      c.note(fmt(L().termAdded, { p: k.phrase }));
      fresh();
      await c.reload();
    } catch (e) {
      c.fail(e);
    }
  };

  const missView = () => {
    const box = h('div', {});
    if (!misses || seenM !== at()) return pending(box, 'misses');
    const T = L();
    box.append(h('p', { class: 'cnt' }, fmt(T.days, { d: misses.days })));
    if (misses.heat?.length) box.append(h('p', { class: 'hint' }, T.legend));
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
      const li = h(
        'li',
        { class: 'red' },
        `${nameOf(m.key)} · ${m.key} — ${parts.join(' · ')} `,
        btn(T.show, () => c.open(m.key))
      );
      // Заход 11: команды «не туди» этой цели — «Перепривязати».
      const wr = (misses.wrong ?? []).filter((w) => w.key === m.key);
      if (wr.length) {
        const sub = h('ul', { class: 'wrong' });
        for (const w of wr)
          sub.append(
            h(
              'li',
              {},
              fmt(T.wrongRow, { p: w.phrase, v: w.visitors, n: w.count }),
              ' ',
              btn(T.rebind, () => rebind(w)),
              clash(w)
            )
          );
        li.append(sub);
      }
      ul.append(li);
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
              c.note(fmt(T.bindHint, { p: a.phrase }));
              c.bind(a.phrase, a.lang);
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
              : k.kind === 'wrong'
                ? fmt(T.sWrong, {
                    p: k.phrase,
                    k: nameOf(k.key),
                    v: k.visitors,
                  })
                : k.kind === 'term'
                  ? fmt(T.sTerm, { p: k.phrase, v: k.visitors })
                  : fmt(T.sSelf, { k: nameOf(k.key), n: k.count })
          ),
          k.kind === 'wrong' && clash(k),
          h(
            'div',
            { class: 'acts' },
            k.kind === 'asked'
              ? btn(
                  T.bind,
                  () => {
                    c.note(fmt(T.bindHint, { p: k.phrase }));
                    c.bind(k.phrase, k.lang);
                  },
                  'pri'
                )
              : k.kind === 'wrong'
                ? btn(T.rebind, () => rebind(k), 'pri')
                : k.kind === 'term'
                  ? btn(T.addTerm, () => void addTerm(k), 'pri')
                  : btn(T.open, () => c.open(k.key), 'pri'),
            btn(T.reject, () => void mute(k.id)())
          )
        )
      );
    return box;
  };

  return {
    heat() {
      if (!misses || seenM !== at() || !misses.heat) return [];
      return misses.heat.map((m) => {
        const nf = m.notFound + m.missed;
        return {
          key: m.key,
          label: [
            `🗣${m.done + m.self + nf}`,
            m.self && `✋${m.self}`,
            m.wrong && `↩${m.wrong}`,
            nf && `?${nf}`,
          ]
            .filter(Boolean)
            .join(' '),
          bad: m.self + m.wrong + nf > 0,
        };
      });
    },
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
