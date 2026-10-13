/**
 * Инструкция генератора `pub.questions.cluster`, версия 1 (P-B2, проектный документ §12.4).
 * Любая правка текста — новая версия (`pub.questions.cluster@2`) и новая конфигурация
 * `not_run`; тест `instructions.spec.ts` сверяет hash текста с записанным.
 */
import { COMMON_RULES_V1 } from './common.v1';

export const INSTRUCTION_VERSION = 'pub.questions.cluster@1';

export const INSTRUCTION_TEXT = `${COMMON_RULES_V1}
Завдання: запропонувати групи питань за задачею користувача. Питання з різними задачами не об’єднуй; ризик злиття опиши в merge_risk.
Частотності не вигадуй — таких полів немає. Оцінки 0–2 з поясненням кожної; невідоме — score null.
Схема: {"groups": [{"key": рядок a-z0-9_-, "task": рядок, "stage": "awareness"|"consideration"|"decision"|"unknown", "audience": рядок або null, "question_ids": [id], "rationale": рядок, "merge_risk": рядок або null, "suggested_scores": {"offer_fit"|"confirmed_task"|"own_answer"|"cost": {"score": 0|1|2|null, "why": рядок}}}], "unclustered_question_ids": [id], "unresolved_questions": [рядки]}.`;
