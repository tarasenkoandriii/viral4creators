import assert from 'node:assert/strict';
import {
  audienceIsEmpty,
  formatTime,
  parseInterests,
  scoreColor,
} from '../src/lib/audience';

assert.equal(audienceIsEmpty(null), true);
assert.equal(
  audienceIsEmpty({
    ageRange: null,
    gender: null,
    interests: [],
    summary: null,
    source: 'gemini',
  }),
  true
);
assert.equal(
  audienceIsEmpty({
    ageRange: '25-34',
    gender: null,
    interests: [],
    summary: null,
    source: 'user',
  }),
  false
);
assert.equal(formatTime(7.4), '0:07');
assert.equal(formatTime(65), '1:05');
assert.equal(formatTime(-3), '0:00');
assert.equal(scoreColor(85), 'bg-emerald-500');
assert.equal(scoreColor(50), 'bg-amber-500');
assert.equal(scoreColor(20), 'bg-rose-500');
assert.deepEqual(parseInterests(' бег, ЗОЖ;бег\nстиль,, '), [
  'бег',
  'ЗОЖ',
  'стиль',
]);
assert.equal(parseInterests('a,b,c,d,e,f,g,h,i,j').length, 8);
console.log('audience: 11 cases ok');
