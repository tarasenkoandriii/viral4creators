/**
 * Инструкция генератора `pub.distribution.plan`, версия 1 (P-B2, проектный документ §12.4).
 * Любая правка текста — новая версия (`pub.distribution.plan@2`) и новая конфигурация
 * `not_run`; тест `instructions.spec.ts` сверяет hash текста с записанным.
 */
import { COMMON_RULES_V1 } from './common.v1';

export const INSTRUCTION_VERSION = 'pub.distribution.plan@1';

export const INSTRUCTION_TEXT = `${COMMON_RULES_V1}
Завдання: чернетка календаря розповсюдження. Версії, канали й дати — лише з переданих. Канал, де реклама заборонена, для промо — лише в blocked із причиною.
Схема: {"actions": [{"version_id": id, "channel_id": id, "format": рядок, "goal": рядок, "proposed_date": "YYYY-MM-DD", "owner_role": "product_owner"|"editor"|"operator", "requires_measurable_link": булеве, "note": рядок}], "blocked": [{"channel_id": id, "reason": рядок}], "unresolved_questions": [рядки]}.`;
