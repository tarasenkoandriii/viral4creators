/**
 * Ссылка с лендинга поздравлений → предвыбранный повод в мастере
 * (§4 п.3 docs-tz/TZ-Greeting-Video-Landing.md).
 *
 * Проверяется чистая часть: разбор параметра и производные от него
 * умолчания. Сам React-экран тут не поднимается — в проекте нет
 * DOM-тестов, и заводить их ради трёх строк логики было бы дороже, чем
 * польза; зато логика вынесена так, что её видно.
 *
 * Правка по аудиту лендинга обучалки: раньше в этом файле лежала КОПИЯ
 * разбора, переписанная от руки, — такой тест остаётся зелёным и после
 * того, как оригинал уехал, потому что проверяет копию, а не код.
 * Теперь зовётся та же функция, что и экран (`landing-entry.ts`).
 */
import assert from 'node:assert/strict';
import * as backendPolicyNs from '../../backend/src/common/greeting-policy';
import { GREETING_OCCASIONS } from '../src/types/project';
import { occasionFromSearch } from '../src/features/projects/landing-entry';
import {
  allowedTones,
  briefRegister,
  recommendedTone,
} from '../src/lib/greeting-policy';

// Этап D (Т-18): своей копии тонов во фронтенде нет — умолчание экрана
// создания берётся из таблицы сервера, поэтому и проверяется по ней же,
// живой, а не по рукописной копии (почему — см. greeting-policy.test.ts;
// там же — зачем разворачивать `default` у CJS-модуля бэкенда).
const backend =
  (backendPolicyNs as { default?: typeof backendPolicyNs }).default ??
  backendPolicyNs;
const policy = JSON.parse(JSON.stringify(backend.greetingPolicyView()));

assert.equal(
  occasionFromSearch('?entry=greetings&occasion=WEDDING'),
  'WEDDING'
);
assert.equal(
  occasionFromSearch('?entry=greetings'),
  null,
  'без повода — умолчание'
);
assert.equal(
  occasionFromSearch('?occasion=NOPE'),
  null,
  'неизвестный код игнорируется'
);

// Каждая плитка лендинга ведёт кодом из этого же списка — значит любой
// из них обязан разбираться, а не только те, что попались на глаза.
for (const occasion of GREETING_OCCASIONS) {
  assert.equal(occasionFromSearch(`?occasion=${occasion}`), occasion);
  // И умолчание тона для него обязано быть допустимым: иначе переход по
  // плитке «Соболезнование» открыл бы форму с тоном, который сервер
  // сразу отвергнет.
  // «Особый повод» — исключение: до ответа о настроении регистра нет, и
  // умолчания тоже; экран не подставляет его, пока человек не ответит.
  if (occasion === 'OTHER') continue;
  const register = briefRegister(policy, occasion, null);
  const tone = recommendedTone(policy, occasion, register);
  if (!tone) throw new Error(`нет умолчания тона для ${occasion}`);
  assert.ok(
    allowedTones(policy, occasion, register)?.includes(tone),
    `умолчание тона недопустимо для ${occasion}`
  );
}

console.log('greeting-entry: ok');
