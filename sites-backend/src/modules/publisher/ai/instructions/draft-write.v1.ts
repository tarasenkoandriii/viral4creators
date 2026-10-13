/**
 * Инструкция генератора `pub.draft.write`, версия 1 (P-B2, проектный документ §12.4).
 * Любая правка текста — новая версия (`pub.draft.write@2`) и новая конфигурация
 * `not_run`; тест `instructions.spec.ts` сверяет hash текста с записанным.
 */
import { COMMON_RULES_V1 } from './common.v1';

export const INSTRUCTION_VERSION = 'pub.draft.write@1';

export const INSTRUCTION_TEXT = `${COMMON_RULES_V1}
Завдання: чернетка статті за готовим брифом лише з контексту. Кандидати тверджень перелічи окремо з джерелами.
Схема: {"title": рядок, "short_answer": рядок, "body_markdown": рядок markdown без HTML, "example": рядок, "limitations": [рядки], "used_source_ids": [id], "claim_candidates": [{"statement": рядок, "type": "fact"|"estimate"|"hypothesis"|"example", "source_ids": [id]}], "unresolved_questions": [рядки]}.`;
