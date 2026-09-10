import assert from 'node:assert/strict';
import {
  defaultCasting,
  defaultTextFor,
  photoSlots,
  toggleActive,
  withReplacement,
} from '../src/lib/casting';
import type { AnalysisCharacter, CharacterCast } from '../src/types';

const ch = (id: string): AnalysisCharacter => ({
  id,
  label: id,
  role: null,
  appearance: `look-${id}`,
  prominence: 'main',
});
const none = {
  kind: 'none' as const,
  photoUrl: null,
  photoPathname: null,
  description: null,
  brandCharacterId: null,
  label: null,
};
const cast = (
  id: string,
  active: boolean,
  order: number,
  photo = false
): CharacterCast => ({
  characterId: id,
  active,
  order,
  replacement: photo
    ? {
        ...none,
        kind: 'photo',
        photoUrl: `https://b/${id}.png`,
        photoPathname: `p/${id}`,
      }
    : none,
});

assert.deepEqual(
  defaultCasting([ch('c1'), ch('c2')]).map((c) => [
    c.characterId,
    c.active,
    c.order,
  ]),
  [
    ['c1', true, 1],
    ['c2', true, 2],
  ]
);

// toggle: deactivate keeps replacement, order → 0
let t = toggleActive([cast('c1', true, 1, true), cast('c2', true, 2)], 'c1');
assert.deepEqual(
  t.find((c) => c.characterId === 'c1'),
  {
    characterId: 'c1',
    active: false,
    order: 0,
    replacement: {
      kind: 'photo',
      description: null,
      photoUrl: null,
      brandCharacterId: null,
      label: null,
    },
  },
  'photoUrl is not echoed back for kind=photo (server keeps its own)'
);
// re-activate appends to the end
t = toggleActive(
  [cast('c1', false, 0), cast('c2', true, 1), cast('c3', true, 2)],
  'c1'
);
assert.equal(t.find((c) => c.characterId === 'c1')?.order, 3);
// unknown id gets a fresh active cast
t = toggleActive([cast('c1', true, 1)], 'c9');
assert.deepEqual(t.find((c) => c.characterId === 'c9')?.active, true);

// photoSlots: first 3 by order among active photo casts
const slots = photoSlots([
  cast('c1', true, 4, true),
  cast('c2', true, 1, true),
  cast('c3', true, 2, true),
  cast('c4', true, 3, true),
  cast('c5', false, 0, true),
]);
assert.deepEqual([...slots].sort(), ['c2', 'c3', 'c4']);

// withReplacement: brand keeps photoUrl, text does not
const w = withReplacement([cast('c1', true, 1)], 'c1', {
  kind: 'brand',
  photoUrl: 'https://b/x.png',
  label: 'Аня',
  brandCharacterId: 'bc1',
});
assert.deepEqual(w[0].replacement, {
  kind: 'brand',
  description: null,
  photoUrl: 'https://b/x.png',
  brandCharacterId: 'bc1',
  label: 'Аня',
});

// Этап 56: сообщение о том, что персонаж держит товар, больше не зашито —
// приходит от вызывающего (dict.casting.holdsProductTemplate).
const textT = { holdsProduct: 'Держит и показывает товар «{{name}}»{{desc}}.' };

assert.equal(defaultTextFor(ch('c1'), null, null, textT), 'look-c1.');
assert.equal(
  defaultTextFor(ch('c1'), 'Кружка', 'стальная 500 мл', textT),
  'look-c1. Держит и показывает товар «Кружка» — стальная 500 мл.'
);
assert.equal(
  defaultTextFor(ch('c1'), 'Кружка', null, textT),
  'look-c1. Держит и показывает товар «Кружка».'
);
console.log('casting: 9 cases ok');
