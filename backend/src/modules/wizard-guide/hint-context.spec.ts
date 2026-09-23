/**
 * Срез корпуса, штамп и чистка ответа — «Тонкая красная линия» §5.5,
 * §5.6, §5.10. Проверки из таблицы §13 плюс то, что нашёл аудит волн
 * A+B.
 */

import {
  buildHintInstruction,
  cleanHint,
  digestOfFacts,
  hintCacheKey,
  HINT_CONTEXT_MAX_CHARS,
} from './hint-context';
import { HINT_DOC_SLUGS } from './hint-actions';
import { SCENARIO_HINTS, knowledgeStamp, stepIdsOf } from './hint-scenarios';
import { SUPPORTED_LOCALES } from '../../common/locale';
import type { FreeScenario } from '../../common/test-user-scenarios';

/** Правдоподобно длинное состояние: фактов у сценария бывает много. */
const FACTS = Array.from({ length: 12 }, (_, i) => `факт номер ${i} про шаг`);

describe('срез корпуса (§5.6)', () => {
  it('сам потолок остаётся в расчётном бюджете входа', () => {
    // §5.4 считает вход так: преамбула ≈400 токенов, карточка ≈200, до
    // пяти записей опыта ≈400, факты ≈100 — около 1100 токенов, то есть
    // порядка 4000 знаков. Потолок, поднятый «чтобы влезло», молча
    // умножает счёт на число шагов и число входов в мастер, поэтому
    // проверяется он числом, а не сам собой.
    expect(HINT_CONTEXT_MAX_CHARS).toBeLessThanOrEqual(4000);
  });

  it('любой шаг любого сценария укладывается в потолок', () => {
    // Потолок — это деньги: вход умножается на число шагов и число
    // входов в мастер. Проверка обязана идти по ВСЕМ карточкам, иначе
    // новый сценарий добавит длинный текст, и никто не заметит.
    for (const [scenario, hints] of Object.entries(SCENARIO_HINTS)) {
      for (const card of Object.values(hints!.cards)) {
        for (const locale of SUPPORTED_LOCALES) {
          const text = buildHintInstruction({
            locale,
            scenarioGoal: hints!.goal,
            card,
            facts: FACTS,
            stepIds: stepIdsOf(scenario as FreeScenario),
            docSlugs: HINT_DOC_SLUGS,
          });
          expect(text.length).toBeLessThanOrEqual(HINT_CONTEXT_MAX_CHARS);
        }
      }
    }
  });

  it('обрезается хвост, а не голова', () => {
    // Голова — правила, без которых модель перестаёт слушаться. Терять
    // их дороже, чем пятую запись про грабли.
    const text = buildHintInstruction({
      locale: 'ru',
      scenarioGoal: 'цель',
      card: { stepId: 'url', goal: 'что делают на шаге' },
      facts: FACTS,
      experience: Array.from({ length: 5 }, () => 'о'.repeat(2000)),
    });
    expect(text.length).toBeLessThanOrEqual(HINT_CONTEXT_MAX_CHARS + 1);
    expect(text).toContain('Правила:');
    expect(text).toContain('## Шаг «url»');
  });
});

describe('штамп корпуса (§5.5)', () => {
  it('одинаков при неизменном корпусе', () => {
    expect(knowledgeStamp()).toBe(knowledgeStamp());
  });

  it('меняется от правки карточки — иначе сутки старых советов', () => {
    // Раньше штамп был строкой, которую правили руками; правка текста
    // без правки строки давала сутки советов по прошлой формулировке, и
    // заметить это было нечем.
    const before = knowledgeStamp();
    const card = SCENARIO_HINTS.CLIENT_SITE!.cards.url;
    const original = card.goal;
    card.goal = `${original} и ещё одна мысль`;
    const after = knowledgeStamp();
    card.goal = original;
    expect(after).not.toBe(before);
    expect(knowledgeStamp()).toBe(before);
  });

  it('входит в ключ кеша', () => {
    const key = hintCacheKey({
      scenario: 'CLIENT_SITE',
      stepId: 'url',
      locale: 'ru',
      knowledgeStamp: knowledgeStamp(),
      digest: digestOfFacts(['a']),
    });
    expect(key).toContain(knowledgeStamp());
  });
});

describe('cleanHint', () => {
  it('снимает маркер списка', () => {
    expect(cleanHint('- Начните со страницы входа.')).toBe(
      'Начните со страницы входа.',
    );
  });

  it('снимает кавычки вокруг ВСЕГО ответа', () => {
    expect(cleanHint('"Начните со страницы входа."')).toBe(
      'Начните со страницы входа.',
    );
    expect(cleanHint('«Начните со страницы входа.»')).toBe(
      'Начните со страницы входа.',
    );
  });

  it('не трогает надпись на экране в начале подсказки', () => {
    // Правило 5 преамбулы прямо велит переносить надписи экрана в
    // «ёлочках». Односторонняя обрезка съедала открывающую и оставляла
    // осиротевшую закрывающую в конце фразы.
    const text = '«Готово» появится, когда запишете хотя бы один шаг.';
    expect(cleanHint(text)).toBe(text);
  });

  it('не склеивает две надписи в одну цитату', () => {
    const text = '«Готово» и «Отменить шаг» делают разное.';
    expect(cleanHint(text)).toBe(text);
  });

  it('пустой ответ остаётся пустым', () => {
    expect(cleanHint('   ')).toBe('');
    expect(cleanHint(null)).toBe('');
  });
});
