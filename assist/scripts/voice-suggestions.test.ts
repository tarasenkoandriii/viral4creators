/**
 * Заход 13 (Р-З13-Б3): «Обучение → Голос» — карточки терминов и «не туда»:
 * поля ответа — как у сервера (`TmaSuggestionsView`); разбор строгий (чужие
 * id/ключи, языки, области и операции отмены — вон); клиент ходит по
 * маршрутам контроллера и мусорные id/ключи не отправляет; оптимистичное
 * скрытие и список целей для «перепривязать»; словари трёх языков равны.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ApiClient } from '../src/kit';
import { VOICE_SUGGESTION_TEXTS } from '../src/i18n/voice-suggestions';
import {
  createVoiceMapApi,
  parseSuggestions,
  rebindChoices,
  visibleSuggestions,
} from '../src/lib/voice-map-api';

const ID = 'a'.repeat(24);
const ID2 = 'b'.repeat(24);

// 1. Поля — как у сервера.
{
  const src = readFileSync(
    new URL(
      '../../sites-backend/src/modules/assist-site-voice-map/api-types.ts',
      import.meta.url
    ),
    'utf8'
  );
  const fields = (name: string) => {
    const m = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(
      src
    );
    assert.ok(m, `нет ${name} на сервере`);
    return [...m![1].matchAll(/^\s+(\w+)\??:/gm)].map((x) => x[1]).sort();
  };
  const v = parseSuggestions({
    terms: [{ id: ID, phrase: 'Ксіомі', visitors: 2, count: 3 }],
    wrong: [
      {
        id: ID2,
        key: 'cart',
        phrase: 'доставку',
        lang: 'uk',
        visitors: 2,
        count: 2,
        nameClash: false,
      },
    ],
    targets: [{ key: 'gift', name: 'Подарунок', scope: 'page', page: '/p' }],
  });
  assert.deepEqual(Object.keys(v).sort(), fields('TmaSuggestionsView'));
  assert.deepEqual(Object.keys(v.terms[0]).sort(), fields('TmaTermCard'));
  assert.deepEqual(Object.keys(v.wrong[0]).sort(), fields('TmaWrongCard'));
  assert.deepEqual(Object.keys(v.targets[0]).sort(), fields('TmaRebindTarget'));
}

// 2. Разбор строгий.
{
  const v = parseSuggestions({
    days: 7,
    revision: 4,
    terms: [
      { id: 'nope', phrase: 'x' },
      { id: ID, phrase: '' },
      { id: ID, phrase: 'Ксіомі', visitors: 2 },
    ],
    wrong: [
      { id: ID2, key: 'BAD KEY', phrase: 'x' },
      { id: ID2, key: 'cart', phrase: 'доставку', lang: 'de', nameClash: 1 },
    ],
    targets: [
      { key: 'gift', name: '', scope: 'evil', page: 'javascript:x' },
      { key: '../x' },
    ],
    termsLeft: 99,
  });
  assert.equal(v.revision, 4);
  assert.deepEqual(
    v.terms.map((x) => x.phrase),
    ['Ксіомі']
  );
  assert.equal(v.wrong.length, 1);
  assert.equal(v.wrong[0].lang, null);
  assert.equal(v.wrong[0].nameClash, false);
  assert.deepEqual(v.targets, [
    { key: 'gift', name: 'gift', scope: 'site', page: null },
  ]);
  assert.equal(v.termsLeft, 99);
  const empty = parseSuggestions(null);
  assert.deepEqual(empty.terms, []);
  assert.equal(empty.days, 7);
}

// 3. Клиент: маршруты; отмена — только известные операции черновика.
{
  const calls: Array<[string, string, unknown]> = [];
  let reply: unknown = {};
  const client = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return reply;
    },
  } as unknown as ApiClient;
  const api = createVoiceMapApi(client);
  await api.suggestions('s1');
  reply = {
    revision: 5,
    term: 'Ксіомі',
    undo: [{ op: 'set-terms', terms: [] }, { op: 'publish' }, 7],
  };
  const t = await api.acceptTerm('s1', 4, ID);
  assert.deepEqual(t, {
    revision: 5,
    undo: [{ op: 'set-terms', terms: [] }],
    term: 'Ксіомі',
  });
  reply = {
    revision: 6,
    key: 'gift',
    detached: true,
    undo: [{ op: 'upsert-target', target: { key: 'gift', synonyms: {} } }],
  };
  const r = await api.rebind('s1', 5, ID2, 'gift');
  assert.equal(r.detached, true);
  assert.equal(r.undo.length, 1);
  await api.muteSuggestion('s1', ID);
  assert.deepEqual(calls, [
    ['GET', '/assist/sites/s1/voice-map/site/suggestions', undefined],
    [
      'POST',
      '/assist/sites/s1/voice-map/site/suggestions/term',
      { expectedRevision: 4, id: ID },
    ],
    [
      'POST',
      '/assist/sites/s1/voice-map/site/suggestions/rebind',
      { expectedRevision: 5, id: ID2, to: 'gift' },
    ],
    ['POST', '/assist/sites/s1/voice-map/site/suggestions/mute', { id: ID }],
  ]);
  await assert.rejects(api.acceptTerm('s1', 1, '../x'));
  await assert.rejects(api.rebind('s1', 1, ID, 'BAD KEY'));
  await assert.rejects(api.muteSuggestion('s1', 'x'));
  await assert.rejects(api.suggestions('a/b'));
  assert.equal(calls.length, 4);
}

// 4. Оптимистичное скрытие и цели «перепривязать».
{
  const v = parseSuggestions({
    terms: [{ id: ID, phrase: 'Ксіомі' }],
    wrong: [{ id: ID2, key: 'cart', phrase: 'доставку' }],
    targets: [
      { key: 'cart', name: 'В кошик' },
      { key: 'gift', name: 'Подарунок' },
    ],
  });
  assert.deepEqual(visibleSuggestions(v, [ID]).terms, []);
  assert.equal(visibleSuggestions(v, [ID]).wrong.length, 1);
  assert.equal(visibleSuggestions(v, []).terms.length, 1);
  assert.deepEqual(
    rebindChoices(v, v.wrong[0]).map((x) => x.key),
    ['gift']
  );
}

// 5. Словари: ключи равны (и вложенные), тексты не пустые.
{
  const keys = (o: unknown, p = ''): string[] =>
    o && typeof o === 'object'
      ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
          keys(v, `${p}${k}.`)
        )
      : [p];
  const uk = keys(VOICE_SUGGESTION_TEXTS.uk).sort();
  assert.deepEqual(keys(VOICE_SUGGESTION_TEXTS.ru).sort(), uk);
  assert.deepEqual(keys(VOICE_SUGGESTION_TEXTS.en).sort(), uk);
}

console.log('voice-suggestions: ok');
