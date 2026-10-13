/**
 * Инструкция генератора `pub.adaptation.make`, версия 1 (P-B2, проектный документ §12.4).
 * Любая правка текста — новая версия (`pub.adaptation.make@2`) и новая конфигурация
 * `not_run`; тест `instructions.spec.ts` сверяет hash текста с записанным.
 */
import { COMMON_RULES_V1 } from './common.v1';

export const INSTRUCTION_VERSION = 'pub.adaptation.make@1';

export const INSTRUCTION_TEXT = `${COMMON_RULES_V1}
Завдання: адаптувати погоджену батьківську версію під формат (post, cards, checklist, video_script), зберігши зміст, ціну, умови та застереження.
Не додавай нових чисел ефективності, знижок, гарантій чи обіцянок. Застереження батьківської версії перелічи в preserved_caveats.
Для video_script — сцени (scenes) і is_script=true: це сценарій, а не готовий файл. Для інших форматів is_script=false. Поля формату, що не застосовуються, — null.
parent_version — точна позначка батьківської версії з запиту. Якщо батьківська версія застаріла — підготуй нову й зазнач потребу нового погодження.
Схема: {"parent_version": рядок, "format": "post"|"cards"|"checklist"|"video_script", "title": рядок, "body": рядок або null, "cards": [{"title": рядок, "text": рядок}] або null, "scenes": [{"visual": рядок, "voice": рядок, "caption": рядок}] або null, "is_script": булеве, "cta": рядок, "used_source_ids": [id], "preserved_caveats": [рядки], "unresolved_questions": [рядки]}.`;
