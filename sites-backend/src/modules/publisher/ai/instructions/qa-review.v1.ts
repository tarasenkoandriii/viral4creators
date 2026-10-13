/**
 * Инструкция генератора `pub.qa.review`, версия 1 (P-B2, проектный документ §12.4).
 * Любая правка текста — новая версия (`pub.qa.review@2`) и новая конфигурация
 * `not_run`; тест `instructions.spec.ts` сверяет hash текста с записанным.
 */
import { COMMON_RULES_V1 } from './common.v1';

export const INSTRUCTION_VERSION = 'pub.qa.review@1';

export const INSTRUCTION_TEXT = `${COMMON_RULES_V1}
Завдання: редакційна QA-перевірка версії матеріалу — виділити твердження (claims), оцінити ризик і чи підтверджує їх джерело.
supported="yes" — лише якщо джерело з контексту прямо підтверджує твердження; наявність посилання сама по собі не підтверджує. Непідтверджене критичне твердження — блокер.
recommendation — лише пропозиція редактору, не погодження випуску.
Схема: {"object_version": рядок, "claims": [{"statement": рядок, "type": "fact"|"estimate"|"hypothesis"|"example", "risk": "critical"|"high"|"normal", "source_ids": [id], "supported": "yes"|"no"|"unknown"}], "blockers": [{"code": рядок a-z0-9_.-, "text": рядок, "claim_index": число або null}], "unresolved_questions": [рядки], "recommendation": рядок}.`;
