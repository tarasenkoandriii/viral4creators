/**
 * Фильтр токенов стрима ДО показа (ТЗ §6.5 п.4б, §4.6) — W3, чистый.
 *
 * Стрим уходит посетителю раньше пост-фильтра (§4.7 — компромисс
 * лендинга), но два исхода инъекции нельзя отдавать даже на секунду:
 * ссылку на чужой хост (фишинг от имени сайта) и разметку (картинка/HTML
 * в чате). Поэтому каждый кусок текста проходит здесь: адреса не с хостов
 * сайта, markdown-картинки, HTML-теги и [S#], которого не было в промпте,
 * вырезаются. Слово может прийти разрезанным — неотправленным держится
 * хвост после последнего пробела (как DelimiterStreamBuffer держит
 * возможное начало разделителя), но не длиннее `maxHoldChars`.
 *
 * Сохраняемый текст = ровно то, что ушло посетителю (тот же фильтр), —
 * продолжение стрима по `streamOffset` (§4-бис.4) читает то же самое.
 */
import { URL_LIKE, bareHost, hostOfUrlLike } from './answer-checks';

const DANGEROUS_SCHEME = /\b(?:javascript|data|vbscript|file):\S*/gi;
const MD_IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/g;
const MD_LINK_TARGET = /\]\(([^)\s]+)\)/g;
const HTML_TAG = /<\/?[a-z!][^<>]*>/gi;
const MARKER = /\[\s*S\s*\d+(?:\s*[,;]\s*S?\s*\d+)*\s*\]/gi;

export interface StreamGuardOptions {
  siteHosts: Set<string>;
  /** Номера [S#] из промпта; пусто — любые маркеры вырезаются. */
  sourceNumbers: Set<number>;
  maxHoldChars?: number;
}

/** Чистка законченного куска текста (границы — пробелы). */
export function guardText(text: string, o: StreamGuardOptions): string {
  const hosts = new Set([...o.siteHosts].map(bareHost));
  const own = (s: string) => {
    const h = hostOfUrlLike(s);
    return h !== null && hosts.has(h);
  };
  return text
    .replace(MD_IMAGE, '')
    .replace(HTML_TAG, '')
    .replace(DANGEROUS_SCHEME, '')
    .replace(MD_LINK_TARGET, (m, url: string) => (own(url) ? m : ']'))
    .replace(URL_LIKE, (m) => (own(m) ? m : ''))
    .replace(MARKER, (m) => {
      const ok = [...m.matchAll(/\d+/g)]
        .map((d) => Number(d[0]))
        .filter((n) => o.sourceNumbers.has(n));
      return ok.length ? m : '';
    });
}

/**
 * Начало незакрытой конструкции разметки в `s` (или -1): HTML-тег `<…`
 * без `>`, markdown `[…`/`![…` без `]`, `](…` без `)`. Внутри тега и
 * подписи ссылки есть пробелы (`<img src=x onerror=…>`, `![a b](url)`) —
 * резка по пробелу иначе отдала бы конструкцию двумя кусками, и ни один
 * шаблон guardText не узнал бы её целиком (аудит Э2).
 */
export function unclosedMarkupStart(s: string): number {
  let at = -1;
  const take = (i: number) => {
    if (i >= 0 && (at < 0 || i < at)) at = i;
  };
  const withBang = (i: number) => (i > 0 && s[i - 1] === '!' ? i - 1 : i);
  const lt = s.lastIndexOf('<');
  if (lt >= 0 && s.indexOf('>', lt) < 0) take(lt);
  const lb = s.lastIndexOf('[');
  if (lb >= 0 && s.indexOf(']', lb) < 0) take(withBang(lb));
  const lp = s.lastIndexOf('](');
  if (lp >= 0 && s.indexOf(')', lp) < 0) {
    const open = s.lastIndexOf('[', lp);
    take(open >= 0 ? withBang(open) : lp);
  }
  return at;
}

export class StreamTextGuard {
  private pending = '';
  private visible = '';

  constructor(private readonly o: StreamGuardOptions) {}

  /** Всё, что уже показано (после фильтра). */
  get text(): string {
    return this.visible;
  }

  /** Новый кусок модели → безопасная часть для показа ('' — ждать). */
  push(piece: string): string {
    if (!piece) return '';
    this.pending += piece;
    const max = this.o.maxHoldChars ?? 300;
    let cut = Math.max(
      this.pending.lastIndexOf(' '),
      this.pending.lastIndexOf('\n'),
    );
    if (cut < 0 && this.pending.length <= max) return '';
    if (cut < 0) cut = this.pending.length - 1;
    // Незакрытый тег/ссылка — держать с её начала (не дольше maxHoldChars).
    const open = unclosedMarkupStart(this.pending.slice(0, cut + 1));
    if (open >= 0 && this.pending.length - open <= max) {
      cut = open - 1;
      if (cut < 0) return '';
    }
    const ready = this.pending.slice(0, cut + 1);
    this.pending = this.pending.slice(cut + 1);
    return this.emit(ready);
  }

  /** Конец стрима: остаток. */
  flush(): string {
    const rest = this.pending;
    this.pending = '';
    return this.emit(rest);
  }

  private emit(chunk: string): string {
    if (!chunk) return '';
    const safe = guardText(chunk, this.o);
    this.visible += safe;
    return safe;
  }
}
