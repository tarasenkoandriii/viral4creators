/**
 * AI Publisher — спецификация генератора зоны P-B2: контракт
 * `GeneratorSpec` (P-A1, §12.1) + проверка ответа против ВХОДА.
 *
 * `postCheck(out, ctx)` видит только контекст; id, которые генератор берёт
 * из входа (вопросы, версии, каналы, площадки), — «подмножество переданных»
 * так же, как `used_source_ids` (§12.2: нарушение — ошибка схемы,
 * критическая). Поэтому `inputIssues` шлюз считает частью схемы: непустой
 * список — `schema_invalid` (и одна повторная попытка).
 */
import type {
  AiContext,
  GeneratorSpec,
  PostCheckFinding,
} from '../../contracts/ai';
import type { FieldIssue } from '../../contracts/errors';

export interface PubGeneratorSpec<I, O> extends GeneratorSpec<I, O> {
  inputIssues?(out: O, input: I): FieldIssue[];
  /**
   * Находки после схемы, которым нужен вход (P-R M2, `pub.reddit.draft`:
   * политика ссылок, аффилированность брифа). Шлюз добавляет их к
   * `postCheck` — как находки, а не как ошибку схемы (Р-RD-56).
   */
  inputFindings?(out: O, input: I, ctx: AiContext): PostCheckFinding[];
}

export function outsideIssues(field: string, ids: string[]): FieldIssue[] {
  return ids.length ? [{ field, code: 'outside_input' }] : [];
}
