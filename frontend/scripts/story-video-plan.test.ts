// Plain assertions runnable with `npx tsx scripts/story-video-plan.test.ts`.
//
// WP4 Story‑Tales: тело запроса сборки/сметы, произношения, своя запись
// вступления, строки сметы повторного заказа.

import {
  applyPronunciations,
  arrayBufferToBase64,
  cleanPronunciations,
  renderStatusLabel,
  storyBuildGate,
  storyPreambleWav,
  storyQuoteRows,
  storyQuoteSummary,
  storyVideoRequest,
  STORY_PREAMBLE_WAV_RATE,
  type StoryVideoQuote,
} from '../src/features/stories/story-video-plan';

let failed = 0;
let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}
function eq(a: unknown, b: unknown) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${x} !== ${y}`);
}
function ok(v: unknown, msg = 'expected truthy') {
  if (!v) throw new Error(msg);
}

check('request: Nova synth sends only the preamble (legacy body)', () => {
  eq(
    storyVideoRequest({
      preambleText: 'Привет',
      preambleSource: 'synth',
      outroText: '  ',
      pronunciations: [{ written: '', spoken: '' }],
    }),
    { preambleText: 'Привет' }
  );
});
check('request: recording, outro, pronunciations and profile consent', () => {
  eq(
    storyVideoRequest({
      preambleText: 'Привет',
      preambleSource: 'recorded',
      recordingId: 'rec',
      outroText: ' Спокойной ночи. ',
      pronunciations: [{ written: ' Жучка ', spoken: 'Жу+чка' }],
      profileId: 'm1',
      voiceConsent: true,
      voiceConsentVersion: 'story-parent-voice-v1',
    }),
    {
      preambleText: 'Привет',
      preambleSource: 'recorded',
      recordingId: 'rec',
      outroText: 'Спокойной ночи.',
      pronunciations: [{ written: 'Жучка', spoken: 'Жу+чка' }],
      narratorManifestId: 'm1',
      voiceConsentVersion: 'story-parent-voice-v1',
      voiceConsentAccepted: true,
    }
  );
});
check(
  'request: narrator image only with a profile voice, never by default',
  () => {
    const base = {
      preambleText: 'Привет',
      preambleSource: 'synth' as const,
      useNarratorImage: true,
    };
    // Without a profile voice the flag is not sent (Nova + cover).
    eq(storyVideoRequest(base), { preambleText: 'Привет' });
    eq(
      storyVideoRequest({
        ...base,
        profileId: 'm1',
        voiceConsent: true,
        voiceConsentVersion: 'v1',
      }),
      {
        preambleText: 'Привет',
        narratorManifestId: 'm1',
        voiceConsentVersion: 'v1',
        voiceConsentAccepted: true,
        useNarratorImage: true,
      }
    );
    eq(
      'useNarratorImage' in
        storyVideoRequest({
          ...base,
          useNarratorImage: false,
          profileId: 'm1',
          voiceConsent: true,
        }),
      false
    );
  }
);
check('pronunciations: validation mirrors the server', () => {
  eq(cleanPronunciations([{ written: 'Жучка', spoken: 'Жу1чка' }]).list, []);
  ok(cleanPronunciations([{ written: 'Жучка', spoken: '' }]).error);
  ok(
    cleanPronunciations([
      { written: 'Жучка', spoken: 'а' },
      { written: 'жучка', spoken: 'б' },
    ]).error
  );
  ok(
    cleanPronunciations(
      Array.from({ length: 6 }, (_, i) => ({ written: `А${i}`, spoken: 'а' }))
    ).error
  );
  eq(
    cleanPronunciations([{ written: 'Жучка', spoken: 'Жу+чка завтра' }]).error,
    '«Как произнести» — одно слово без пробелов'
  );
  ok(cleanPronunciations([{ written: 'Жучка', spoken: 'а'.repeat(41) }]).error);
  eq(cleanPronunciations([{ written: 'Андрій', spoken: 'Андри+й' }]), {
    list: [{ written: 'Андрій', spoken: 'Андри+й' }],
    error: null,
  });
});
check('pronunciations: whole words only, case-insensitive', () => {
  eq(
    applyPronunciations('Жучка и жучка, но не Жучкам.', [
      { written: 'Жучка', spoken: 'Жу+чка' },
    ]),
    'Жу+чка и Жу+чка, но не Жучкам.'
  );
});
check('recording: stereo 48 kHz → mono 22.05 kHz WAV, trimmed to 20 s', () => {
  const rate = 48000;
  const len = rate * 25;
  const ch = new Float32Array(len).fill(0.25);
  const r = storyPreambleWav({
    sampleRate: rate,
    numberOfChannels: 2,
    getChannelData: () => ch,
  });
  ok(r.trimmed, 'trimmed');
  ok(Math.abs(r.seconds - 20) < 0.01, `seconds ${r.seconds}`);
  const v = new DataView(r.wav);
  eq(v.getUint16(22, true), 1);
  eq(v.getUint32(24, true), STORY_PREAMBLE_WAV_RATE);
  ok(r.wav.byteLength < 1_000_000, `bytes ${r.wav.byteLength}`);
  const short = storyPreambleWav({
    sampleRate: rate,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(rate / 2),
  });
  ok(short.tooShort, 'too short');
});
check('base64 of a large buffer is chunk-safe', () => {
  const buf = new Uint8Array(200000).map((_, i) => i % 256).buffer;
  const raw = atob(arrayBufferToBase64(buf));
  eq(raw.length, 200000);
  eq(raw.charCodeAt(1234), 1234 % 256);
});
const quote: StoryVideoQuote = {
  sideEffects: 'none',
  configHash: 'c',
  existingRender: null,
  baseRevision: 'turnip-v1',
  baseHash: 'b',
  voice: { label: 'Мой голос', profile: 'parent', cloning: false },
  segments: [
    {
      kind: 'intro',
      source: 'recorded',
      text: 'Привет',
      ttsText: 'Привет',
      pronunciations: [],
      visual: 'cover',
      state: 'reuse',
      seconds: 4,
      characters: 0,
    },
    {
      kind: 'gift_note',
      position: 'beginning',
      source: 'synth',
      text: 'Ищи книжку',
      ttsText: 'Ищи кни+жку',
      pronunciations: ['книжку'],
      visual: 'photo',
      state: 'synthesize',
      seconds: null,
      characters: 11,
    },
    {
      kind: 'main',
      source: 'parent',
      text: 'Репка',
      ttsText: 'Репка',
      pronunciations: [],
      visual: 'base',
      state: 'reuse',
      seconds: 55,
      characters: 0,
    },
  ],
  layout: null,
  reserveMicroUsd: 520000,
  reservedMicroUsd: 1000000,
  budgetMicroUsd: 5000000,
  remainingMicroUsd: 4000000,
  fits: true,
  blockers: [],
  hints: [],
};
check('quote rows: labels, respelling preview and photo note', () => {
  const rows = storyQuoteRows(quote);
  eq(
    rows.map((r) => [r.label, r.source, r.state]),
    [
      ['Вступление', 'ваша запись', 'переиспользуется'],
      ['Реплика о подарке (в начале)', 'синтез', 'будет синтезирован'],
      ['Сказка', 'голос из профиля', 'переиспользуется'],
    ]
  );
  eq(rows[1].spoken, 'Ищи кни+жку');
  eq(rows[0].spoken, null);
  eq(rows[1].note, 'На экране — фото подарка');
  const withImage = storyQuoteRows({
    ...quote,
    segments: [{ ...quote.segments[0], visual: 'narrator' }],
  });
  eq(withImage[0].note, 'На экране — образ рассказчика из профиля');
});
check(
  'quote summary: estimated length when segments are not synthesized yet',
  () => {
    eq(
      storyQuoteSummary({
        ...quote,
        layout: { durationSeconds: 61.25 },
        layoutEstimated: true,
      }).includes('длительность ≈ 61.3 с'),
      true
    );
  }
);
check('quote summary: reuse vs synthesis, reserve and no re-cloning', () => {
  eq(
    storyQuoteSummary(quote),
    'Переиспользуется: 2 · синтезируется заново: 1 · резерв $0.52 · остаток бюджета $4.00 · голос не клонируется повторно'
  );
  ok(
    storyQuoteSummary({
      ...quote,
      existingRender: { id: 'r1', status: 'READY' },
    }).includes('без новых оплат')
  );
});

check(
  'build gate (S2-3): only a fresh quote without blockers and within budget',
  () => {
    const none = storyBuildGate(null, false);
    eq(none.ok, false);
    ok(none.reason?.includes('Предпросмотр сегментов и смета'));
    eq(
      storyBuildGate({ ...quote, blockers: ['Нет согласия'] }, true).ok,
      false
    );
    const over = storyBuildGate({ ...quote, fits: false }, true);
    eq(over.ok, false);
    ok(over.reason?.includes('$0.52'), String(over.reason));
    eq(storyBuildGate(quote, true), {
      ok: true,
      label: 'Собрать с голосом из профиля · резерв $0.52',
      reason: null,
    });
    eq(storyBuildGate(quote, false).label, 'Собрать с Nova · резерв $0.52');
    ok(
      storyBuildGate(
        { ...quote, existingRender: { id: 'r1', status: 'READY' } },
        false
      ).label.includes('без новых оплат')
    );
  }
);
check(
  'FAILED/DELETED same config is a new attempt, not "already built" (F1)',
  () => {
    for (const status of ['FAILED', 'DELETED']) {
      const q = { ...quote, existingRender: { id: 'r1', status } };
      ok(!storyQuoteSummary(q).includes('уже'), storyQuoteSummary(q));
      eq(
        storyBuildGate(q, true).label,
        'Собрать с голосом из профиля · резерв $0.52'
      );
    }
    const pending = {
      ...quote,
      existingRender: { id: 'r1', status: 'PENDING' },
    };
    ok(storyQuoteSummary(pending).includes('уже запущена (собирается)'));
    ok(storyBuildGate(pending, false).label.includes('уже запущенную'));
  }
);
check('render status labels (S3-12): Russian, never the raw code', () => {
  eq(renderStatusLabel('READY'), 'готово');
  eq(renderStatusLabel('UNKNOWN'), 'требует проверки оператора');
  eq(renderStatusLabel('SOMETHING_NEW'), 'статус уточняется');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
