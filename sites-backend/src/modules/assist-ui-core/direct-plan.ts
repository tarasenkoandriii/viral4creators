/**
 * Прямой путь без модели (§5-бис.3, дополнение 1.4: «при точном совпадении
 * фразы с одной целью — прямой путь без модели»): «відкрий доставку»,
 * «нажми Каталог», «знайди футболку». Дешевле и быстрее (задержка «конец
 * фразы → первая подсветка», §5-бис.10), а результат всё равно проходит
 * `checkPlan` — прямой путь не обходит ни одной проверки.
 */
import { normText, sameWord, tokens } from './normalize';
import type { RawStep } from './plan-checks';
import type { UiSnapshot } from './types';

const CLICK_VERBS =
  /^(відкрий(те)?|натисни|натисніть|перейди(ть)?|відкрити|открой(те)?|нажми(те)?|перейди(те)?|open|click|press|tap|go to)\s+/u;
const FIND_VERBS =
  /^(знайди(ть)?|шукай|пошукай|найди(те)?|ищи|поищи|find|search( for)?|look for)\s+/u;

/** Команда-действие (а не вопрос) — первое слово из глаголов действия. */
export function looksLikeCommand(transcript: string): boolean {
  // Команда из одного глагола («оплати!») — тоже команда.
  const t = normText(transcript)
    .replace(/[.!?,…]+$/u, '')
    .replace(/^(будь ласка|пожалуйста|please),?\s+/u, '');
  return (
    CLICK_VERBS.test(t) ||
    FIND_VERBS.test(t) ||
    /^(додай(те)?|добавь(те)?|add|заповни(ть)?|заполни(те)?|fill|введи(ть|те)?|enter|type|вибери(ть)?|обери(ть)?|выбери(те)?|select|choose|постав(те)?|поставь(те)?|check|прокрути(ть|те)?|scroll|закрий(те)?|закрой(те)?|close|покажи(ть|те)?|show|оплати(ть|те)?|pay|видали(ть)?|удали(те)?|delete|оформи(ть|те)?|скасуй(те)?|отмени(те)?|cancel|завантаж(те)?|загрузи(те)?|upload|скопіюй(те)?|скопируй(те)?|copy|надішли(ть)?|відправ(те)?|отправь(те)?|send|submit)(\s+|$)/u.test(
      t,
    )
  );
}

export function directPlan(
  transcript: string,
  snapshot: UiSnapshot,
): RawStep[] | null {
  const t = normText(transcript).replace(/[.!?]+$/u, '');
  const find = FIND_VERBS.exec(t);
  if (find) {
    const query = t.slice(find[0].length).trim();
    const boxes = snapshot.elements.filter(
      (e) =>
        !e.disabled &&
        (e.role === 'searchbox' ||
          e.assistId === 'search' ||
          e.inputType === 'search'),
    );
    if (query && boxes.length === 1)
      return [{ kind: 'fill', target: boxes[0].ref, value: query }];
    return null;
  }
  const click = CLICK_VERBS.exec(t);
  if (!click) return null;
  const want = tokens(t.slice(click[0].length));
  if (!want.length) return null;
  const hits = snapshot.elements.filter((e) => {
    if (e.disabled) return false;
    if (!['link', 'button', 'tab', 'menuitem'].includes(e.role)) return false;
    const have = tokens(e.text);
    return (
      have.length > 0 &&
      have.length === want.length &&
      have.every((h) => want.some((w) => sameWord(h, w))) &&
      want.every((w) => have.some((h) => sameWord(h, w)))
    );
  });
  if (hits.length !== 1) return null;
  return [{ kind: 'click', target: hits[0].ref }];
}
