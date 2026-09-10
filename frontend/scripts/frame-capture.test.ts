import assert from 'node:assert/strict';
import {
  clampTime,
  previewRequests,
  previewSize,
} from '../src/lib/frame-capture';

// clampTime: inside the clip, never on the final frame
assert.equal(clampTime(3, 10), 3);
assert.equal(clampTime(-2, 10), 0);
assert.equal(clampTime(12, 10), 9.85);
assert.equal(clampTime(5, NaN), 5);

// previewRequests: characters with previewAt, scenes default to the middle, skip captured
const reqs = previewRequests({
  characters: [
    {
      id: 'c1',
      label: 'a',
      role: null,
      appearance: 'x',
      prominence: 'main',
      previewAt: 1.5,
    },
    {
      id: 'c2',
      label: 'b',
      role: null,
      appearance: 'y',
      prominence: 'main',
      previewAt: null,
    },
    {
      id: 'c3',
      label: 'c',
      role: null,
      appearance: 'z',
      prominence: 'main',
      previewAt: 2,
      previewUrl: 'https://done',
    },
  ],
  scenes: [
    { id: 's1', start: 0, end: 4, title: 't', previewAt: null },
    { id: 's2', start: 4, end: 6, title: 'u', previewAt: 5.5 },
  ],
});
assert.deepEqual(reqs, [
  { key: 'character:c1', time: 1.5 },
  { key: 'scene:s1', time: 2 },
  { key: 'scene:s2', time: 5.5 },
]);
assert.deepEqual(previewRequests(undefined), []);

// previewSize: longest side capped, aspect kept
assert.deepEqual(previewSize(1080, 1920), { width: 270, height: 480 });
assert.deepEqual(previewSize(320, 180), { width: 320, height: 180 });
assert.deepEqual(previewSize(0, 0), { width: 480, height: 480 });
console.log('frame-capture: 10 cases ok');
