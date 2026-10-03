/**
 * Проверки ответа модели после стрима (ТЗ §4.6, §4.7, §4.9, §6.5 п.4б) —
 * ЧИСТЫЕ, W3. Стрим к этому моменту ушёл (осознанный компромисс лендинга):
 * фильтр не переписывает показанное, а (1) вырезает из СОХРАНЯЕМОГО и
 * отдаваемого в `sources`/`actions` всё непроверенное, (2) ставит флаги.
 * Строгий режим цифр (§4.7) — Business+ (Э4); в Э2 — выключен.
 *
 * Что всё-таки защищено ещё ДО показа — `StreamTextGuard` (stream-guard.ts):
 * ссылки на чужие хосты и несуществующие [S#] вырезаются из токенов стрима
 * (§6.5 п.4б «ссылки — только на хосты сайта»), иначе «злая» модель,
 * исполнившая инъекцию, успела бы показать посетителю ссылку на evil.com.
 */
import {
  DEFAULT_MASK_LABELS,
  containsAnyPhrase,
  maskSensitiveEcho,
  parseActionsBlock,
} from '../../shared/assist-chat-core';
import {
  FORBIDDEN_PROMISES,
  unsupportedNumbers,
} from '../assist-knowledge-core/answer/sanitize';
import { detectInjection } from '../assist-knowledge-core/injection';
import type { SearchHit } from '../assist-knowledge-core/types';
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import type { PromptVideo } from '../assist-site-media/public/site-videos';
import {
  ELEMENT_REF_RE,
  VIDEO_REF_RE,
} from '../assist-site-media/media-config';
import type { UiMapElement } from '../site-core/ui-map/ui-map';
import type {
  SiteAction,
  SiteActionKind,
  SiteAnswerSource,
} from './chat-types';

/** Маркеры источников `[S3]`, `[S1, S2]`, `[S1][S2]` (как у песочницы Э1). */
const MARKER = /\[\s*S\s*\d+(?:\s*[,;]\s*S?\s*\d+)*\s*\]/gi;

/** [S#] в тексте → источники; номер, которого не было в промпте, вырезается. */
export function resolveCitations(
  text: string,
  sourceMap: Map<number, SearchHit>,
): { text: string; sources: SiteAnswerSource[] } {
  const cited: number[] = [];
  const out = text.replace(MARKER, (m) => {
    const nums = [...m.matchAll(/\d+/g)]
      .map((d) => Number(d[0]))
      .filter((n) => sourceMap.has(n));
    const uniq = [...new Set(nums)];
    for (const n of uniq) if (!cited.includes(n)) cited.push(n);
    return uniq.map((n) => `[S${n}]`).join('');
  });
  const sources = [...cited]
    .sort((a, b) => a - b)
    .map((n) => {
      const h = sourceMap.get(n) as SearchHit;
      return { n, url: h.url, title: h.title };
    });
  return {
    text: out
      .replace(/[ \t]+([.,;:!?])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .trim(),
    sources,
  };
}

/** Хост из URL нижним регистром без `www.` (сравнение «хост сайта»). */
export function bareHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

/** URL для сравнения «ссылка есть среди фрагментов»: без фрагмента и концевого `/`. */
export function normalizeLinkUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${bareHost(u.hostname)}${u.port ? `:${u.port}` : ''}${path}${u.search}`;
}

/** Подпись кнопки — только текст: без тегов, управляющих символов, ≤ 60. */
export function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮]/g, '')
    .replace(/[<>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.length > 60) return null;
  return t;
}

/**
 * Э6: что модели можно назвать в `video`/`highlight` — ровно то, что ЭТОТ
 * запрос положил в промпт (`V#` — ролики сайта, `E#` — элементы карты
 * страницы посетителя, по порядку). Второй барьер против ролика чужого
 * сайта: id ролика, селектор и подпись берутся отсюда, не из текста модели.
 */
export interface MediaAllowed {
  videos: PromptVideo[];
  elements: UiMapElement[];
  /** Страница карты элементов (`хост` + `путь`) — в действие `highlight`. */
  page?: string | null;
}

/** `E1`… → элемент карты (номер — позиция в промпте). */
export function elementByRef(
  elements: UiMapElement[],
  ref: unknown,
): UiMapElement | null {
  if (typeof ref !== 'string') return null;
  const m = ELEMENT_REF_RE.exec(ref);
  return m ? (elements[Number(m[1]) - 1] ?? null) : null;
}

/** `V1`… → ролик из списка этого запроса. */
export function videoByRef(
  videos: PromptVideo[],
  ref: unknown,
): PromptVideo | null {
  if (typeof ref !== 'string' || !VIDEO_REF_RE.test(ref)) return null;
  return videos.find((v) => v.ref === ref) ?? null;
}

/**
 * Действия из блока `<<<actions>>>` (parseActionsBlock из assist-chat-core):
 * kind только из SITE_ACTION_KINDS; link — https, хост сайта, URL есть среди
 * фрагментов или настроек сайта; ≤ 3; подписи — текст ≤ 60. Э6: `video` и
 * `highlight` — только ссылки на списки этого запроса (`media`), не больше
 * одного каждого (как «не больше одного видео» лендинга, `actions.ts`).
 */
export function validateSiteActions(
  raw: string | null,
  allowed: {
    linkUrls: Set<string>;
    siteHosts: Set<string>;
    media?: MediaAllowed;
  },
): SiteAction[] {
  const media: MediaAllowed = allowed.media ?? { videos: [], elements: [] };
  const hosts = new Set([...allowed.siteHosts].map(bareHost));
  const urls = new Set(
    [...allowed.linkUrls]
      .map((u) => normalizeLinkUrl(u))
      .filter((u): u is string => u !== null),
  );
  const linkOk = (url: unknown): boolean => {
    if (typeof url !== 'string' || url.length > 2000) return false;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== 'https:') return false;
    if (!hosts.has(bareHost(u.hostname))) return false;
    const n = normalizeLinkUrl(url);
    return n !== null && urls.has(n);
  };
  const parsed = parseActionsBlock<
    { kind: SiteActionKind } & Record<string, unknown>,
    SiteActionKind
  >(raw, {
    validators: {
      link: (f) => cleanLabel(f.label) !== null && linkOk(f.url),
      lead: (f) => cleanLabel(f.label) !== null,
      handoff: (f) => cleanLabel(f.label) !== null,
      video: (f) =>
        cleanLabel(f.label) !== null && !!videoByRef(media.videos, f.video),
      highlight: (f) =>
        cleanLabel(f.label) !== null &&
        !!elementByRef(media.elements, f.element),
    },
    maxItems: WIDGET_DEFAULTS.maxActions,
    maxPerKind: { lead: 1, handoff: 1, video: 1, highlight: 1 },
  });
  return parsed.map((a): SiteAction => {
    const label = cleanLabel(a.label) as string;
    if (a.kind === 'link') {
      return { kind: 'link', label, url: new URL(a.url as string).toString() };
    }
    if (a.kind === 'video') {
      const v = videoByRef(media.videos, a.video) as PromptVideo;
      return { kind: 'video', label, videoId: v.id, title: v.title };
    }
    if (a.kind === 'highlight') {
      const e = elementByRef(media.elements, a.element) as UiMapElement;
      return {
        kind: 'highlight',
        label,
        elementId: e.id,
        selector: e.selector,
        caption: e.label,
        ...(media.page ? { page: media.page } : {}),
      };
    }
    return { kind: a.kind, label };
  });
}

export type SiteAnswerFlag =
  | 'unsupported_number'
  | 'forbidden_promise'
  | 'stop_phrase'
  | 'no_citation'
  | 'foreign_link'
  | 'injection_suspect';

/** Адреса в тексте: со схемой, `www.` и «голые» домены распространённых зон. */
const URL_TAIL = `[^\\s<>()[\\]"']*[^\\s<>()[\\]"'.,;:!?»…]`;
export const URL_LIKE = new RegExp(
  `\\b(?:https?|ftp):\\/\\/${URL_TAIL}|\\bwww\\.${URL_TAIL}|(?<![@\\p{L}\\p{N}._-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:com|net|org|ua|ru|io|co|info|biz|xyz|top|site|online|shop|store|app|dev|me|link|click|ly|to|cc|eu|uk|de|pl|us|pro|tech|ai)\\b(?:\\/(?:${URL_TAIL})?)?`,
  'giu',
);

/** Хост адреса из текста (`evil.com/x` → `evil.com`), null — не адрес. */
export function hostOfUrlLike(s: string): string | null {
  const withScheme = /^[a-z]+:\/\//i.test(s) ? s : `https://${s}`;
  try {
    return bareHost(new URL(withScheme).hostname);
  } catch {
    return null;
  }
}

/** Адреса текста, чей хост — не хост сайта. */
export function foreignLinks(text: string, siteHosts: Set<string>): string[] {
  const hosts = new Set([...siteHosts].map(bareHost));
  const out: string[] = [];
  for (const m of text.matchAll(URL_LIKE)) {
    const h = hostOfUrlLike(m[0]);
    if (!h || !hosts.has(h)) out.push(m[0]);
  }
  return out;
}

/**
 * Пост-фильтр (§4.7): числа ответа ищутся в тексте процитированных
 * НЕ-UGC фрагментов и вопросе; стоп-фразы заказчика + платформенный
 * список запрещённых обещаний; ссылки на чужие хосты.
 */
export function postFilterAnswer(p: {
  text: string;
  question: string;
  cited: SearchHit[];
  stopPhrases: string[];
  siteHosts: Set<string>;
}): SiteAnswerFlag[] {
  const flags: SiteAnswerFlag[] = [];
  // UGC — мнение посетителя: его числа подтверждением не считаются (§4-тер.7).
  const support = p.cited
    .filter((h) => !h.ugc)
    .map((h) => `${h.title ?? ''} ${h.headingPath ?? ''} ${h.text}`);
  if (unsupportedNumbers(p.text, support, p.question).length > 0) {
    flags.push('unsupported_number');
  }
  if (containsAnyPhrase(p.text, FORBIDDEN_PROMISES)) {
    flags.push('forbidden_promise');
  }
  const stops = p.stopPhrases
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (stops.length && containsAnyPhrase(p.text, stops)) {
    flags.push('stop_phrase');
  }
  if (p.cited.length === 0) flags.push('no_citation');
  if (foreignLinks(p.text, p.siteHosts).length > 0) flags.push('foreign_link');
  if (detectInjection(p.text).quarantine) flags.push('injection_suspect');
  return flags;
}

/** Подписи маскирования журнала (кабинет и журнал — по-русски, как у лендинга). */
export const JOURNAL_MASK = {
  card: '[номер карты скрыт]',
  iban: '[счёт скрыт]',
} as const;

const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g;
/**
 * Телефон в «свободной» записи: `+380 (67) 123-45-67` — шаблон лендинга
 * (assist-chat-core) не берёт два разделителя подряд («) (»). 9–15 цифр:
 * время «9:00», цены «1 500» и даты без разделителей сюда не попадают.
 */
const PHONE_LOOSE = /\+?\d[\d\s().-]{7,22}\d/g;
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;

/** Проверка Луна: отличает номер карты от просто длинного числа. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

/**
 * Маскирование для журнала — вопрос И ответ (§4.7, приёмка Э2 п.6):
 * maskSensitiveEcho (assist-chat-core) + номера карт и IBAN-подобные строки.
 * Подписи — на языке интерфейса кабинета (русские, как у лендинга).
 * Порядок: IBAN и карта — раньше телефона, иначе их съел бы шаблон
 * телефона (тоже скрыто, но с неверной подписью).
 */
export function maskForJournal(text: string): string {
  return maskSensitiveEcho(
    text
      .replace(IBAN, (m) =>
        /\d{8,}/.test(m.replace(/\s/g, '')) ? JOURNAL_MASK.iban : m,
      )
      .replace(CARD_CANDIDATE, (m) =>
        luhnValid(m.replace(/\D/g, '')) ? JOURNAL_MASK.card : m,
      )
      .replace(PHONE_LOOSE, (m) => {
        const digits = m.replace(/\D/g, '').length;
        return digits >= 9 && digits <= 15 ? DEFAULT_MASK_LABELS.phone : m;
      }),
  );
}
