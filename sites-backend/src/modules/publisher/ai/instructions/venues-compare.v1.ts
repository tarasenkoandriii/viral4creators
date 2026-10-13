/**
 * Инструкция генератора `pub.venues.compare`, версия 1 (P-B2, проектный документ §12.4).
 * Любая правка текста — новая версия (`pub.venues.compare@2`) и новая конфигурация
 * `not_run`; тест `instructions.spec.ts` сверяет hash текста с записанным.
 */
import { COMMON_RULES_V1 } from './common.v1';

export const INSTRUCTION_VERSION = 'pub.venues.compare@1';

export const INSTRUCTION_TEXT = `${COMMON_RULES_V1}
Завдання: порівняти картки майданчиків за однаковими критеріями з доказами. Прогнозу переходів не роби — такого поля немає. Невідоме — score null і запис у gaps.
Схема: {"venues": [{"venue_id": id, "criteria": {"topic"|"geo_language"|"format"|"evidence_freshness"|"real_distribution": {"score": 0|1|2|null, "why": рядок, "evidence_source_ids": [id]}}, "gaps": [рядки], "risks": [рядки]}], "unresolved_questions": [рядки]}.`;
