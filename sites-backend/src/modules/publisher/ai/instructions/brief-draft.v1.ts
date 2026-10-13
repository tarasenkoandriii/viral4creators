/**
 * Инструкция генератора `pub.brief.draft`, версия 1 (P-B2, проектный документ §12.4).
 * Любая правка текста — новая версия (`pub.brief.draft@2`) и новая конфигурация
 * `not_run`; тест `instructions.spec.ts` сверяет hash текста с записанным.
 */
import { COMMON_RULES_V1 } from './common.v1';

export const INSTRUCTION_VERSION = 'pub.brief.draft@1';

export const INSTRUCTION_TEXT = `${COMMON_RULES_V1}
Завдання: підготувати чернетку брифа матеріалу за питанням і джерелами.
Аудиторію, власний внесок і рішення, яких немає в контексті, не вигадуй: став null і додай у unresolved_questions.
CTA має відповідати наміру читача; поясни доречність у intent_fit_note.
Схема: {"question": рядок, "audience": рядок або null, "source_ids": [id], "original_contribution": рядок або null, "short_answer": рядок, "structure": [рядки], "format": "instruction"|"case_review"|"choice_guide", "cta": {"text": рядок, "intent_fit_note": рядок}, "channels": [рядки], "limitations": [рядки], "unresolved_questions": [рядки]}.`;
