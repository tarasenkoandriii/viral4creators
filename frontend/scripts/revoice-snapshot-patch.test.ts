import assert from 'node:assert/strict';
import { revoiceSnapshotPatch } from '../src/lib/revoice-snapshot-patch';

const base = {
  isGreeting: false,
  snapshot: {
    ttsVoiceId: 'v1',
    ttsProvider: 'resemble',
    voiceMode: 'voiceover' as const,
  },
  ttsVoiceId: 'v1',
  providerOverride: null,
  voiceMode: 'voiceover' as const,
};

// Ничего не меняли — PATCH не нужен.
assert.equal(revoiceSnapshotPatch(base), null);

// Сменили только режим на дубляж (Півасік 0.5, 01.10.2026: два голоса
// в voiceover) — уезжает ровно режим, голос не трогаем.
assert.deepEqual(revoiceSnapshotPatch({ ...base, voiceMode: 'dub' }), {
  voiceMode: 'dub',
});

// Сменили только голос — режим не пересылаем.
assert.deepEqual(revoiceSnapshotPatch({ ...base, ttsVoiceId: 'v2' }), {
  ttsVoiceId: 'v2',
});

// И то и другое, с явным провайдером.
assert.deepEqual(
  revoiceSnapshotPatch({
    ...base,
    ttsVoiceId: 'v2',
    providerOverride: 'soniox',
    voiceMode: 'dub',
  }),
  { ttsVoiceId: 'v2', ttsProvider: 'soniox', voiceMode: 'dub' }
);

// Снимок уже в дубляже, селектор на нём же — не изменение.
assert.equal(
  revoiceSnapshotPatch({
    ...base,
    snapshot: { ...base.snapshot, voiceMode: 'dub' },
    voiceMode: 'dub',
  }),
  null
);

// Поздравление — снимка брендбука нет, патча нет при любых правках.
assert.equal(
  revoiceSnapshotPatch({ ...base, isGreeting: true, voiceMode: 'dub' }),
  null
);
console.log('revoice-snapshot-patch: ok');
