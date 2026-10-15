/**
 * AI Publisher — чистые функции форм «Бренд и оффер» и «Источники»
 * (вынесены из `screens/publisher/content/{BrandScreen,SourcesScreen}.tsx`
 * без изменения поведения; их же переиспользует вкладка «Reddit» Админки
 * через `scripts/sync-admin-reddit-shared.mjs`):
 *  - значение факта бренда по виду (`price` — `{amountMinor, currency,
 *    note?}`, `faq` — `{question, answer}`, прочие — `{text}`) и готовность;
 *  - тело ручного источника (пустые необязательные поля — `null`).
 */
import type { BrandFactKind, SourceKind, SourceVisibility } from './states';
import type { CreateSourceIn } from './content-api';

export interface FactValueForm {
  text: string;
  amount: string;
  currency: string;
  question: string;
  answer: string;
}

/** Значение факта и готовность формы (ключ — отдельно, у вызывающего). */
export function factValue(
  kind: BrandFactKind | '',
  f: FactValueForm
): { value: unknown; ready: boolean } {
  const value =
    kind === 'price'
      ? {
          amountMinor: Number(f.amount),
          currency: f.currency.trim(),
          ...(f.text.trim() ? { note: f.text.trim() } : {}),
        }
      : kind === 'faq'
        ? { question: f.question.trim(), answer: f.answer.trim() }
        : { text: f.text.trim() };
  const ready =
    !!kind &&
    (kind === 'price'
      ? /^\d+$/.test(f.amount) && !!f.currency.trim()
      : kind === 'faq'
        ? !!f.question.trim() && !!f.answer.trim()
        : !!f.text.trim());
  return { value, ready };
}

export interface SourceForm {
  kind: SourceKind | '';
  title: string;
  url: string;
  author: string;
  publishedOn: string;
  fragment: string;
  language: string;
  visibility: SourceVisibility | '';
  usage: 'allowed' | 'restricted' | '';
}

/** Тело ручного источника; `null` — форма неполна. */
export function sourceBody(f: SourceForm): CreateSourceIn | null {
  if (
    !f.kind ||
    !f.title.trim() ||
    !f.fragment.trim() ||
    !f.visibility ||
    !f.usage
  )
    return null;
  return {
    kind: f.kind,
    title: f.title.trim(),
    url: f.url.trim() || null,
    author: f.author.trim() || null,
    publishedOn: f.publishedOn || null,
    fragment: f.fragment.trim(),
    language: f.language.trim() || null,
    visibility: f.visibility,
    usage: f.usage,
  };
}
