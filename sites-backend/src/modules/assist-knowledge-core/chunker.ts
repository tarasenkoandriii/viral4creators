/**
 * Чанкинг — K2 (§4.3): 300–500 токенов, перекрытие 50; заголовки → путь
 * («Доставка › По Украине»); таблица — построчно с заголовком (строку
 * `tr` экстрактор уже пишет «Колонка: значение; …», и строка не режется);
 * FAQ — пара целиком; UGC-блоки — отдельными фрагментами с ugc=true (не
 * смешивать с текстом владельца: у отзыва пониженный вес, §6.5). Токены —
 * оценка (символы/4 с поправкой на кириллицу) без вызова провайдера.
 *
 * Разделы: новый заголовок закрывает фрагмент, если в нём уже ≥ minTokens
 * (иначе мелкие соседние разделы склеиваются — фрагмент в 20 токенов
 * плохо ищется и дорог в промпте). Перекрытие — только внутри раздела:
 * хвост «Оплаты» в начале «Доставки» путал бы поиск.
 */
import type { ExtractedBlock } from '../site-crawl/types';
import { contentHash, digitsMaskedHash, normalizeChunkText } from './hashing';
import type { ChunkDraft } from './types';

export interface ChunkOptions {
  minTokens: number;
  maxTokens: number;
  overlapTokens: number;
  lang: string | null;
}

/** Разделитель пути заголовков в headingPath. */
export const HEADING_SEPARATOR = ' › ';

/**
 * Латиница ≈ 4 символа на токен, кириллица ≈ 2.5 — та же формула, что у
 * оценки эмбеддинга (site-ai/embedder.ts): лимит фрагмента и деньги
 * считаются одной мерой.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cyr = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x0400 && c <= 0x04ff) cyr++;
  }
  const other = text.length - cyr;
  return Math.max(1, Math.ceil(other / 4 + cyr / 2.5));
}

interface Unit {
  text: string;
  tokens: number;
  path: string[];
  heading: boolean;
}

interface Piece {
  units: Unit[];
  tokens: number;
  ugc: boolean;
  /** FAQ-пара: к ней ничего не приклеивается. */
  atomic?: boolean;
}

/** Предложения; если предложение длиннее лимита — по словам. */
function splitLong(text: string, max: number): string[] {
  const sentences = text.match(/[^.!?…]+(?:[.!?…]+|$)\s*/gu) ?? [text];
  const out: string[] = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = '';
  };
  for (const s of sentences) {
    if (estimateTokens(s) > max) {
      push();
      let w = '';
      for (const word of s.split(/\s+/u)) {
        const next = w ? `${w} ${word}` : word;
        if (w && estimateTokens(next) > max) {
          out.push(w);
          w = word;
        } else {
          w = next;
        }
      }
      if (w.trim()) out.push(w.trim());
      continue;
    }
    const next = cur + s;
    if (cur && estimateTokens(next) > max) push();
    cur += s;
  }
  push();
  return out;
}

/** Хвост текста ≈ overlap токенов (по словам) — начало следующего фрагмента. */
function tail(text: string, overlap: number): string {
  if (overlap <= 0) return '';
  const words = text.split(/\s+/u).filter(Boolean);
  const picked: string[] = [];
  let t = 0;
  for (let i = words.length - 1; i >= 0 && t < overlap; i--) {
    picked.unshift(words[i]);
    t = estimateTokens(picked.join(' '));
  }
  // Хвост длиной во весь текст — не перекрытие, а повтор.
  return picked.length < words.length ? picked.join(' ') : '';
}

function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function headingPathOf(units: Unit[]): string | null {
  // Путь — по тексту фрагмента; заголовки — только если текста нет.
  const content = units.filter((u) => !u.heading);
  const paths = (content.length ? content : units)
    .map((u) => u.path)
    .filter((p) => p.length > 0);
  if (paths.length === 0) return null;
  let common = paths[0];
  for (const p of paths.slice(1)) {
    let i = 0;
    while (i < common.length && i < p.length && common[i] === p[i]) i++;
    common = common.slice(0, i);
  }
  const chosen = common.length > 0 ? common : paths[0];
  return chosen.join(HEADING_SEPARATOR);
}

class Packer {
  readonly pieces: Piece[] = [];
  private cur: Piece;

  constructor(
    private readonly opts: ChunkOptions,
    private readonly ugc: boolean,
  ) {
    this.cur = { units: [], tokens: 0, ugc };
  }

  private hasContent(): boolean {
    return this.cur.units.some((u) => !u.heading);
  }

  flush(withOverlap: boolean): void {
    if (!this.hasContent()) return;
    const done = this.cur;
    // Висящие заголовки в конце — начало СЛЕДУЮЩЕГО фрагмента, а не хвост
    // этого (иначе «Повернення» оказался бы во фрагменте про оплату).
    const dangling: Unit[] = [];
    while (done.units.length && done.units[done.units.length - 1].heading) {
      dangling.unshift(done.units.pop()!);
    }
    done.tokens = done.units.reduce((s, u) => s + u.tokens, 0);
    this.pieces.push(done);
    this.cur = { units: [], tokens: 0, ugc: this.ugc };
    if (dangling.length) {
      this.cur.units.push(...dangling);
      this.cur.tokens = dangling.reduce((s, u) => s + u.tokens, 0);
      return;
    }
    if (withOverlap) {
      const last = done.units[done.units.length - 1];
      const t = tail(
        done.units.map((u) => u.text).join('\n'),
        this.opts.overlapTokens,
      );
      if (t) {
        this.cur.units.push({
          text: t,
          tokens: estimateTokens(t),
          path: last.path,
          heading: false,
        });
        this.cur.tokens = estimateTokens(t);
      }
    }
  }

  private add(u: Unit): void {
    this.cur.units.push(u);
    this.cur.tokens += u.tokens;
  }

  heading(u: Unit): void {
    if (this.cur.tokens >= this.opts.minTokens) this.flush(false);
    this.add(u);
  }

  /** FAQ-пара — отдельным фрагментом, без резки (§4.3). */
  atomic(u: Unit): void {
    this.flush(false);
    // Висящие заголовки (без текста под ними) — префикс пары.
    this.add(u);
    this.pieces.push({ ...this.cur, atomic: true });
    this.cur = { units: [], tokens: 0, ugc: this.ugc };
  }

  text(u: Unit): void {
    const last = this.cur.units[this.cur.units.length - 1];
    if (this.hasContent() && this.cur.tokens + u.tokens > this.opts.maxTokens) {
      this.flush(!!last && samePath(last.path, u.path));
    }
    this.add(u);
  }

  finish(): Piece[] {
    this.flush(false);
    // Крошечный хвост — к предыдущему фрагменту, если влезает.
    const n = this.pieces.length;
    if (n >= 2) {
      const a = this.pieces[n - 2];
      const b = this.pieces[n - 1];
      if (
        !a.atomic &&
        !b.atomic &&
        b.tokens < this.opts.minTokens / 3 &&
        a.tokens + b.tokens <= this.opts.maxTokens &&
        !b.units.some((u) => u.heading)
      ) {
        a.units.push(...b.units);
        a.tokens += b.tokens;
        this.pieces.pop();
      }
    }
    return this.pieces;
  }
}

function unitsOf(b: ExtractedBlock, max: number): Unit[] {
  const text = normalizeChunkText(b.text ?? '');
  if (!text) return [];
  const path = b.t === 'h' ? [...(b.path ?? []), text] : [...(b.path ?? [])];
  if (b.t === 'h')
    return [{ text, tokens: estimateTokens(text), path, heading: true }];
  if (b.t === 'faq' || b.t === 'tr' || estimateTokens(text) <= max) {
    return [{ text, tokens: estimateTokens(text), path, heading: false }];
  }
  return splitLong(text, max).map((t) => ({
    text: t,
    tokens: estimateTokens(t),
    path,
    heading: false,
  }));
}

export function chunkBlocks(
  blocks: ExtractedBlock[],
  opts: ChunkOptions,
): ChunkDraft[] {
  const owner = new Packer(opts, false);
  const ugcPieces: Piece[] = [];
  let ugc: Packer | null = null;
  let ugcPath: string[] | null = null;

  for (const b of blocks) {
    if (b.ugc) {
      // Отзывы — своими фрагментами: подряд идущие с одним путём
      // упаковываются вместе, отзыв не режется посередине без нужды.
      const path = b.path ?? [];
      if (!ugc || !ugcPath || !samePath(ugcPath, path)) {
        if (ugc) ugcPieces.push(...ugc.finish());
        ugc = new Packer(opts, true);
        ugcPath = path;
      }
      for (const u of unitsOf(b, opts.maxTokens)) ugc.text(u);
      continue;
    }
    for (const u of unitsOf(b, opts.maxTokens)) {
      if (u.heading) owner.heading(u);
      else if (b.t === 'faq') owner.atomic(u);
      else owner.text(u);
    }
  }
  if (ugc) ugcPieces.push(...ugc.finish());

  const pieces = [...owner.finish(), ...ugcPieces];
  return pieces.map((p, ordinal) => {
    const text = p.units.map((u) => u.text).join('\n');
    return {
      ordinal,
      text,
      headingPath: headingPathOf(p.units),
      tokens: estimateTokens(text),
      contentHash: contentHash(text),
      digitsMaskedHash: digitsMaskedHash(text),
      ugc: p.ugc,
      lang: opts.lang,
    };
  });
}

/**
 * Схема вектора FAQ — в хешах фрагмента: фрагменты, посчитанные по старой
 * схеме («вопрос+ответ»), не совпадут по contentHash/digitsMaskedHash, и их
 * вектор не будет скопирован в новую сборку — FAQ переэмбеддится.
 */
const FAQ_EMBED_SCHEME = 'faq-q:';

export function chunkFaq(
  question: string,
  answer: string,
  lang: string | null,
): ChunkDraft {
  const q = normalizeChunkText(question);
  const a = normalizeChunkText(answer);
  const text = `${q}\n${a}`;
  return {
    ordinal: 0,
    text,
    headingPath: null,
    tokens: estimateTokens(text),
    contentHash: contentHash(`${FAQ_EMBED_SCHEME}${text}`),
    digitsMaskedHash: digitsMaskedHash(`${FAQ_EMBED_SCHEME}${text}`),
    ugc: false,
    lang,
  };
}

/**
 * Текст, по которому считается вектор фрагмента (task=document). У FAQ —
 * только первая строка («вопрос (варианты)»), без ответа: прямой путь
 * виджета (§4.5 п.1, порог 0.92) сравнивает вектор ВОПРОСА посетителя, и
 * на настоящем эмбеддере вектор «вопрос+ответ» почти никогда не даёт
 * ≥ 0.92 — проверенный ответ тонул бы в словах ответа. Поиск по смыслу
 * для FAQ от этого только точнее (вопрос↔вопрос); полнотекст идёт по text.
 */
export function embeddingText(sourceType: string, text: string): string {
  if (sourceType !== 'faq') return text;
  const nl = text.indexOf('\n');
  return nl < 0 ? text : text.slice(0, nl);
}
