import assert from 'node:assert/strict';
import {
  hasMatches,
  highlightLines,
  lineMatches,
  termTokens,
  timecodeTerms,
} from '../src/lib/highlight';

assert.deepEqual(termTokens('Женщина в красной куртке'), [
  'женщина',
  'красной',
  'куртке',
]);
assert.deepEqual(termTokens('the a of'), []);

assert.deepEqual(timecodeTerms(0, 2.4), [
  '0:00-0:02',
  '0:00–0:02',
  '0-2s',
  '0-2',
]);

// половина значимых слов — достаточно
assert.equal(
  lineMatches(
    'Scene 1: woman in a red jacket ties her laces',
    termTokens('woman red jacket'),
    []
  ),
  true
);
assert.equal(
  lineMatches('Product hero shot', termTokens('woman red jacket'), []),
  false
);
assert.equal(
  lineMatches('Scene 2 (0:02-0:05): lacing', [], ['0:02-0:05']),
  true
);

const lines = highlightLines(
  'Scene 1 (0:00-0:02): close-up of running shoes\nScene 2 (0:02-0:05): woman in red jacket\n\nAudio: upbeat',
  ['Женщина в красной куртке', 'woman in red jacket'],
  []
);
assert.deepEqual(
  lines.map((l) => l.match),
  [false, true, false, false]
);
assert.equal(hasMatches(lines), true);
assert.equal(hasMatches(highlightLines('nothing here', ['zzz'])), false);
// пустой фильтр ничего не подсвечивает
assert.equal(hasMatches(highlightLines('any text', [])), false);
console.log('highlight: 11 cases ok');
