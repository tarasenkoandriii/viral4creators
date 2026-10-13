/**
 * Инструкция генератора `pub.claims.extract`, версия 1 (P-B2, проектный документ §12.4).
 * Любая правка текста — новая версия (`pub.claims.extract@2`) и новая конфигурация
 * `not_run`; тест `instructions.spec.ts` сверяет hash текста с записанным.
 */
import { COMMON_RULES_V1 } from './common.v1';

export const INSTRUCTION_VERSION = 'pub.claims.extract@1';

export const INSTRUCTION_TEXT = `${COMMON_RULES_V1}
Завдання: виділити з версії матеріалу перевірювані твердження (claims), їхній тип, ризик і підтвердження джерелами.
supported="yes" — лише при прямому підтвердженні джерелом контексту.
Схема: {"object_version": рядок, "claims": [{"statement": рядок, "type": "fact"|"estimate"|"hypothesis"|"example", "risk": "critical"|"high"|"normal", "source_ids": [id], "supported": "yes"|"no"|"unknown"}], "blockers": [{"code": рядок a-z0-9_.-, "text": рядок, "claim_index": число або null}], "unresolved_questions": [рядки], "recommendation": рядок}.`;
