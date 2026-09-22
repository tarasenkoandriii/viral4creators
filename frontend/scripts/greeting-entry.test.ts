/**
 * Ссылка с лендинга поздравлений → предвыбранный повод в мастере
 * (§4 п.3 docs-tz/TZ-Greeting-Video-Landing.md).
 *
 * Проверяется чистая часть: разбор параметра и производные от него
 * умолчания. Сам React-экран тут не поднимается — в проекте нет
 * DOM-тестов, и заводить их ради трёх строк логики было бы дороже, чем
 * польза; зато логика вынесена так, что её видно.
 */
import assert from 'node:assert/strict';
import {
  GREETING_OCCASIONS,
  allowedTonesFor,
  defaultToneFor,
  type GreetingOccasion,
} from '../src/types/project';

/** Копия разбора из ProjectCreateScreen.occasionFromQuery. */
function parse(search: string): GreetingOccasion | null {
  const raw = new URLSearchParams(search).get('occasion');
  if (!raw) return null;
  return (GREETING_OCCASIONS as readonly string[]).includes(raw)
    ? (raw as GreetingOccasion)
    : null;
}

assert.equal(parse('?entry=greetings&occasion=WEDDING'), 'WEDDING');
assert.equal(parse('?entry=greetings'), null, 'без повода — умолчание');
assert.equal(parse('?occasion=NOPE'), null, 'неизвестный код игнорируется');

// Каждая плитка лендинга ведёт кодом из этого же списка — значит любой
// из них обязан разбираться, а не только те, что попались на глаза.
for (const occasion of GREETING_OCCASIONS) {
  assert.equal(parse(`?occasion=${occasion}`), occasion);
  // И умолчание тона для него обязано быть допустимым: иначе переход по
  // плитке «Соболезнование» открыл бы форму с тоном, который сервер
  // сразу отвергнет.
  assert.ok(
    allowedTonesFor(occasion).includes(defaultToneFor(occasion)),
    `умолчание тона недопустимо для ${occasion}`,
  );
}

console.log('greeting-entry: ok');
