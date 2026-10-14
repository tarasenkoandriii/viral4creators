/**
 * AI Publisher, P-B2 — маскирование журнала AI по сроку хранения чужого
 * текста (P-R M2, раунд исправлений, аудит S3-9; Р-RD-70; разрешение
 * координатора в пределах P-R). Вход вызова в журнале не хранится; выход
 * (`pub_ai_calls.output`) и сырой фрагмент (`rawExcerpt`) вызовов задач
 * объекта (например, Reddit-брифа треда) могут цитировать выдержку треда.
 * Строка ответа, которая содержит выдержку целиком или любую её
 * последовательность из 6 слов, заменяется плейсхолдером; статус, стоимость
 * и токены вызова не меняются (гвард журнала разрешает правку только
 * `output`/`rawExcerpt`).
 */
import type { ProductRef, PubTx } from '../core/ports';
import type { Prisma } from '@prisma/client';

const SHINGLE = 6;

const words = (t: string): string[] =>
  t
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * Проверка «строка цитирует один из текстов»: текст целиком или любая
 * последовательность из 6 слов (короткий текст — целиком по словам).
 */
export function overlapMatcher(
  texts: readonly string[],
): (s: string) => boolean {
  const shingles = new Set<string>();
  const whole: string[] = [];
  for (const t of texts) {
    if (!t) continue;
    whole.push(t);
    const w = words(t);
    if (w.length < SHINGLE) {
      if (w.length) shingles.add(w.join(' '));
      continue;
    }
    for (let i = 0; i + SHINGLE <= w.length; i++)
      shingles.add(w.slice(i, i + SHINGLE).join(' '));
  }
  return (s: string): boolean => {
    if (whole.some((t) => s.includes(t))) return true;
    const w = words(s);
    for (const sh of shingles) {
      const n = sh.split(' ').length;
      for (let i = 0; i + n <= w.length; i++)
        if (w.slice(i, i + n).join(' ') === sh) return true;
    }
    return false;
  };
}

/** Строки JSON, совпавшие с `hit`, → `placeholder`. */
export function scrubJson(
  v: unknown,
  hit: (s: string) => boolean,
  placeholder: string,
): { value: unknown; changed: boolean } {
  let changed = false;
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') {
      if (x !== placeholder && hit(x)) {
        changed = true;
        return placeholder;
      }
      return x;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, y] of Object.entries(x)) out[k] = walk(y);
      return out;
    }
    return x;
  };
  const value = walk(v);
  return { value, changed };
}

/**
 * Вызовы задач объекта (`objectType`, `objectIds`) продукта: строки
 * выхода, цитирующие `texts`, → `placeholder`. Возвращает id изменённых
 * вызовов.
 */
export async function redactAiCallsOf(
  tx: PubTx,
  product: ProductRef,
  objectType: string,
  objectIds: readonly string[],
  texts: readonly string[],
  placeholder: string,
): Promise<string[]> {
  if (!objectIds.length || !texts.some(Boolean)) return [];
  const hit = overlapMatcher(texts);
  const calls = await tx.pubAiCall.findMany({
    where: {
      productId: product.id,
      task: { objectType, objectId: { in: [...objectIds] } },
    },
    select: { id: true, output: true, rawExcerpt: true },
  });
  const changed: string[] = [];
  for (const c of calls) {
    const out =
      c.output === null ? null : scrubJson(c.output, hit, placeholder);
    const raw =
      c.rawExcerpt !== null && c.rawExcerpt !== placeholder && hit(c.rawExcerpt)
        ? placeholder
        : c.rawExcerpt;
    if (!out?.changed && raw === c.rawExcerpt) continue;
    await tx.pubAiCall.update({
      where: { id: c.id },
      data: {
        ...(out?.changed ? { output: out.value as Prisma.InputJsonValue } : {}),
        rawExcerpt: raw,
      },
    });
    changed.push(c.id);
  }
  return changed;
}
