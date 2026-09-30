// Plain assertions runnable with `npx tsx scripts/voice-sync.test.ts`.
//
// Финальный аудит ветки K: правила голоса, продублированные на клиенте
// (хуки полей, закрытые списки контракта, потолки длины, порог согласия,
// цена старта рендера), сверяются с ЖИВЫМИ серверными — тем же приёмом,
// что voice-fields.test.ts. Разошлись — тест красный до выкладки, а не
// «голос молча перестал заполнять поле» после неё.

import * as intentNs from '../../backend/src/common/greeting-voice-intent';
import * as chargeNs from '../../backend/src/common/render-charge';
import * as greetingNs from '../../backend/src/common/types/greeting.types';
import * as voiceNs from '../../backend/src/common/greeting-voice';
import {
  BRIEF_MESSAGE_MAX,
  BRIEF_NAME_MAX,
  BRIEF_VOICE_TARGETS,
} from '../src/lib/voice-brief';
import {
  REFERENCE_DESCRIPTION_MAX,
  REFERENCE_LABEL_MAX,
  SCRIPT_TEXT_MAX,
  SEARCH_QUERY_MAX,
} from '../src/lib/voice-fields';
import {
  CONSENT_CONFIDENCE_MIN,
  renderChargeOf,
  type ChargeFacts,
} from '../src/lib/voice-consent';
import {
  RECORDER_MIME_CANDIDATES,
  SPEECH_DETECTOR_DEFAULTS,
  voiceMaxBytesFor,
} from '../src/lib/voice-listen';
import {
  VOICE_COMMANDS,
  VOICE_CURRENT_FIELDS,
  VOICE_NAVIGATE_TARGETS,
  VOICE_REASONS,
  VOICE_STATUSES,
  VOICE_STEP_IDS,
} from '../src/lib/voice-types';
import { MAX_CUSTOM_OCCASION_LENGTH } from '../src/types/project';

const unwrap = <M>(ns: M): M => (ns as { default?: M }).default ?? ns;
const intent = unwrap(intentNs);
const charge = unwrap(chargeNs);
const greeting = unwrap(greetingNs);
const voice = unwrap(voiceNs);

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

check('хуки брифа — ровно BRIEF_FIELD_HOOKS сервера', () => {
  eq(BRIEF_VOICE_TARGETS, intent.BRIEF_FIELD_HOOKS);
});

check('закрытые списки контракта — те же, что у сервера', () => {
  eq([...VOICE_STATUSES], [...intent.VOICE_STATUSES]);
  eq([...VOICE_REASONS], [...intent.VOICE_REASONS]);
  eq([...VOICE_COMMANDS], [...intent.VOICE_COMMANDS]);
  eq([...VOICE_NAVIGATE_TARGETS], [...intent.VOICE_NAVIGATE_TARGETS]);
  eq([...VOICE_STEP_IDS], [...intent.VOICE_SCREEN_STEPS]);
  eq([...VOICE_CURRENT_FIELDS], [...intent.VOICE_CURRENT_FIELDS]);
});

check('потолки длины — серверные VOICE_*_MAX', () => {
  eq(
    {
      name: BRIEF_NAME_MAX,
      message: BRIEF_MESSAGE_MAX,
      referenceLabel: REFERENCE_LABEL_MAX,
      referenceDescription: REFERENCE_DESCRIPTION_MAX,
      script: SCRIPT_TEXT_MAX,
      searchQuery: SEARCH_QUERY_MAX,
      customOccasion: MAX_CUSTOM_OCCASION_LENGTH,
    },
    {
      name: intent.VOICE_NAME_MAX,
      message: intent.VOICE_MESSAGE_MAX,
      referenceLabel: intent.VOICE_REFERENCE_LABEL_MAX,
      referenceDescription: intent.VOICE_REFERENCE_DESCRIPTION_MAX,
      script: intent.VOICE_SCRIPT_MAX,
      searchQuery: intent.VOICE_SEARCH_QUERY_MAX,
      customOccasion: greeting.MAX_CUSTOM_OCCASION_LENGTH,
    }
  );
});

check('порог согласия — CONSENT_CONFIDENCE_MIN сервера', () => {
  eq(CONSENT_CONFIDENCE_MIN, intent.CONSENT_CONFIDENCE_MIN);
});

check('клиент режет фразу раньше серверного потолка длины', () => {
  if (
    !(SPEECH_DETECTOR_DEFAULTS.maxUtteranceMs < intent.VOICE_UTTERANCE_MAX_MS)
  )
    throw new Error(
      `${SPEECH_DETECTOR_DEFAULTS.maxUtteranceMs} >= ${intent.VOICE_UTTERANCE_MAX_MS}`
    );
});

check('renderChargeOf — перебором совпадает с эталоном сервера', () => {
  const cases: Array<ChargeFacts | null> = [null];
  for (const wallEnabled of [false, true])
    for (const unlocked of [false, true])
      for (const generationsAvailable of [-1, 0, 0.5, 1, 2.7, 5])
        cases.push({ wallEnabled, unlocked, generationsAvailable });
  for (const c of cases) {
    eq(
      { c, charge: renderChargeOf(c) },
      { c, charge: charge.renderChargeOf(c) }
    );
  }
});

check('потолок байт отрезка по типу — greetingVoiceMaxBytesFor сервера', () => {
  const mimes = [
    ...RECORDER_MIME_CANDIDATES,
    'audio/webm',
    'audio/ogg',
    'audio/opus',
    'audio/mp4',
    'audio/m4a',
    'audio/x-m4a',
    'audio/aac',
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/flac',
    'AUDIO/WEBM; codecs=opus',
    'audio/unknown',
    '',
    null,
    undefined,
  ];
  for (const m of mimes) {
    eq(
      { m, max: voiceMaxBytesFor(m) },
      { m, max: voice.greetingVoiceMaxBytesFor(m) }
    );
  }
});

console.log(failed ? `\n${failed} провалено` : `\n${passed} проверок пройдено`);
if (failed) process.exit(1);
