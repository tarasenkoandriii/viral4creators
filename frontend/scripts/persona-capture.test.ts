// Plain assertions runnable with `npx tsx scripts/persona-capture.test.ts`.
//
// «Я в кадре» (ТЗ Greeting 2.0 §4.1 п.2, §4.3, §4.6): съёмка камерой —
// когда вести в веб-версию, формат ролика живости, подсказка поворота
// головы, фраза согласия голоса.

import { readFileSync } from 'node:fs';
import {
  AUDIO_MIME_CANDIDATES,
  baseMime,
  cameraSupport,
  consentPhraseWithName,
  headTurnCue,
  LIVENESS_MS,
  LIVENESS_UPLOAD_MIMES,
  livenessUploadMime,
  pickAudioMime,
  pickVideoMime,
  secondsLeft,
  webVersionUrl,
} from '../src/lib/persona-capture';
import { RECORDER_MIME_CANDIDATES } from '../src/lib/voice-listen';

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

console.log('persona-capture (съёмка камерой, §4.3)');

check('нет getUserMedia (WebView Telegram) — вести в веб-версию', () => {
  eq(
    cameraSupport({
      secureContext: true,
      hasGetUserMedia: false,
      hasMediaRecorder: true,
    }),
    'no-camera'
  );
});
check('без MediaRecorder фото бесполезно — живость обязательна', () => {
  eq(
    cameraSupport({
      secureContext: true,
      hasGetUserMedia: true,
      hasMediaRecorder: false,
    }),
    'no-recorder'
  );
});
check('http — отдельная причина, она важнее прочих', () => {
  eq(
    cameraSupport({
      secureContext: false,
      hasGetUserMedia: false,
      hasMediaRecorder: false,
    }),
    'insecure'
  );
  eq(
    cameraSupport({
      secureContext: true,
      hasGetUserMedia: true,
      hasMediaRecorder: true,
    }),
    'ok'
  );
});

check('ролик: первый формат, который умеет браузер; Safari — mp4', () => {
  eq(
    pickVideoMime(() => true),
    'video/webm;codecs=vp9'
  );
  eq(
    pickVideoMime((m) => m === 'video/mp4'),
    'video/mp4'
  );
  eq(
    pickVideoMime(() => false),
    null
  );
});
check(
  'голос: форматы — только те, что принимает сервер образцов (без ogg)',
  () => {
    const dto = readFileSync(
      new URL(
        '../../backend/src/modules/user-voices/dto/user-voices.dto.ts',
        import.meta.url
      ),
      'utf8'
    );
    const m = dto.match(/ALLOWED_MIME_TYPES\s*=\s*\[([\s\S]*?)\]/);
    if (!m) throw new Error('ALLOWED_MIME_TYPES не найден');
    const allowed = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    for (const c of AUDIO_MIME_CANDIDATES)
      if (!allowed.includes(baseMime(c, '')))
        throw new Error(`${c} не принимается`);
    // Порядок предпочтений — тот же, что у прослушивания, минус ogg.
    eq(
      [...AUDIO_MIME_CANDIDATES],
      RECORDER_MIME_CANDIDATES.filter((c) => !c.startsWith('audio/ogg'))
    );
    eq(
      pickAudioMime((mm) => mm.startsWith('audio/ogg')),
      null
    );
  }
);
check('тип без кодека — сервер сверяет голые типы', () => {
  eq(baseMime('audio/webm;codecs=opus', 'x'), 'audio/webm');
  eq(baseMime(' Video/MP4 ', 'x'), 'video/mp4');
  eq(baseMime('', 'audio/webm'), 'audio/webm');
  eq(baseMime(null, 'audio/webm'), 'audio/webm');
});
check('тип ролика для загрузки — из списка сервера', () => {
  eq(livenessUploadMime('video/webm;codecs=vp9'), 'video/webm');
  eq(livenessUploadMime('video/mp4'), 'video/mp4');
  eq(livenessUploadMime('video/x-matroska;codecs=avc1'), 'video/webm');
  eq(livenessUploadMime(''), 'video/webm');
  const src = readFileSync(
    new URL(
      '../../backend/src/modules/persona/persona-rules.ts',
      import.meta.url
    ),
    'utf8'
  );
  const m = src.match(/PERSONA_LIVENESS_MIME_TYPES\s*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error('PERSONA_LIVENESS_MIME_TYPES не найден');
  eq(
    [...LIVENESS_UPLOAD_MIMES],
    [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  );
});

check('ролик — 3 секунды (§4.1 п.2)', () => {
  eq(LIVENESS_MS, 3000);
});
check('подсказка: прямо → влево → вправо → готово', () => {
  eq(headTurnCue(0), 'straight');
  eq(headTurnCue(999), 'straight');
  eq(headTurnCue(1000), 'left');
  eq(headTurnCue(1999), 'left');
  eq(headTurnCue(2000), 'right');
  eq(headTurnCue(2999), 'right');
  eq(headTurnCue(3000), 'done');
});
check('счётчик — целые секунды «3, 2, 1, 0»', () => {
  eq(secondsLeft(0), 3);
  eq(secondsLeft(100), 3);
  eq(secondsLeft(1001), 2);
  eq(secondsLeft(2999), 1);
  eq(secondsLeft(3500), 0);
});

check(
  'веб-версия — тот же адрес без query Telegram, хеш экрана персоны',
  () => {
    eq(
      webVersionUrl(
        { origin: 'https://app.example', pathname: '/' },
        '/persona'
      ),
      'https://app.example/#/persona'
    );
    eq(
      webVersionUrl(
        { origin: 'https://app.example', pathname: '/tma/' },
        'persona'
      ),
      'https://app.example/tma/#/persona'
    );
  }
);

check('фраза согласия: имя подставляется в любую вставку', () => {
  eq(
    consentPhraseWithName(
      'Я, {{name}}, разрешаю создать копию голоса.',
      'Андрей'
    ),
    'Я, Андрей, разрешаю создать копию голоса.'
  );
  eq(
    consentPhraseWithName('Я, <имя>, разрешаю.', ' Олена '),
    'Я, Олена, разрешаю.'
  );
});
check(
  'вставка сервера `{name}` — та же, что PERSONA_VOICE_NAME_PLACEHOLDER',
  () => {
    const src = readFileSync(
      new URL(
        '../../backend/src/modules/user-voices/persona-voice-consent.ts',
        import.meta.url
      ),
      'utf8'
    );
    const m = src.match(/PERSONA_VOICE_NAME_PLACEHOLDER\s*=\s*'([^']+)'/);
    if (!m) throw new Error('PERSONA_VOICE_NAME_PLACEHOLDER не найден');
    eq(
      consentPhraseWithName(`Я, ${m[1]}, разрешаю.`, 'Андрей'),
      'Я, Андрей, разрешаю.'
    );
    eq(consentPhraseWithName(`Я, ${m[1]}, разрешаю.`, ''), 'Я разрешаю.');
  }
);
check('без имени вставка уходит вместе с запятыми', () => {
  eq(consentPhraseWithName('Я, {{name}}, разрешаю.', ''), 'Я разрешаю.');
  eq(consentPhraseWithName('I, <name>, allow it.', null), 'I allow it.');
});
check('готовая фраза без вставки — как есть', () => {
  eq(consentPhraseWithName('Я разрешаю.', 'Андрей'), 'Я разрешаю.');
});

console.log(`persona-capture: ${passed} проверок пройдено`);
if (failed) {
  console.error(`persona-capture: ${failed} провалено`);
  process.exit(1);
}
