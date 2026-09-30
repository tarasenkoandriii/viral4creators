// Plain assertions runnable with `npx tsx scripts/greeting-render.test.ts`.
//
// CONTRACT6 G-FE п. 1, 4, 5: опрос рендера не умирает на сетевой
// ошибке; кнопка рендера гаснет с причиной; «ролик в работе».

import { readFileSync } from 'node:fs';
import {
  VOICE_START_ERROR_CODES,
  isVoiceStartError,
  pollSettled,
  voiceTrackIssue,
  RENDER_POLL_BASE_MS,
  RENDER_POLL_MAX_MS,
  isVideoBusy,
  renderBlockOf,
  renderPollDelay,
  renderPollErrorKind,
} from '../src/lib/greeting-render';

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

check(
  'пауза опроса: без сбоев — обычный шаг; сбои — удвоение до потолка',
  () => {
    eq(renderPollDelay(0), RENDER_POLL_BASE_MS);
    eq(renderPollDelay(1), RENDER_POLL_BASE_MS * 2);
    eq(renderPollDelay(2), RENDER_POLL_BASE_MS * 4);
    eq(renderPollDelay(3), RENDER_POLL_BASE_MS * 8);
    eq(renderPollDelay(10), RENDER_POLL_MAX_MS);
    eq(renderPollDelay(1000), RENDER_POLL_MAX_MS);
    eq(renderPollDelay(-1), RENDER_POLL_BASE_MS);
  }
);

check(
  'ошибка опроса: сеть/408/429/5xx — пробуем снова; прочие 4xx — стоп',
  () => {
    eq(renderPollErrorKind(undefined), 'retry');
    eq(renderPollErrorKind(null), 'retry');
    eq(renderPollErrorKind(408), 'retry');
    eq(renderPollErrorKind(429), 'retry');
    eq(renderPollErrorKind(500), 'retry');
    eq(renderPollErrorKind(503), 'retry');
    eq(renderPollErrorKind(401), 'stop');
    eq(renderPollErrorKind(403), 'stop');
    eq(renderPollErrorKind(404), 'stop');
  }
);

const ready = {
  items: [
    { key: 'recipient', stepId: 'brief', required: true, done: true },
    { key: 'sender', stepId: 'brief', required: false, done: false },
  ],
};
const notReady = {
  items: [
    ...ready.items,
    { key: 'face', stepId: 'references', required: true, done: false },
  ],
};

check(
  'кнопка рендера: FLAGGED и BYPASSED — «сценарий не прошёл проверку»',
  () => {
    eq(
      renderBlockOf({ moderationStatus: 'flagged', readiness: ready }),
      'flagged'
    );
    eq(
      renderBlockOf({ moderationStatus: 'bypassed', readiness: ready }),
      'flagged'
    );
    // Проверка важнее готовности: причина — одна, самая точная.
    eq(
      renderBlockOf({ moderationStatus: 'flagged', readiness: notReady }),
      'flagged'
    );
  }
);

check('кнопка рендера: невыполненный ОБЯЗАТЕЛЬНЫЙ пункт — «не готово»', () => {
  eq(
    renderBlockOf({ moderationStatus: 'approved', readiness: notReady }),
    'not-ready'
  );
  // Необязательный пункт кнопку не гасит.
  eq(renderBlockOf({ moderationStatus: 'approved', readiness: ready }), null);
  eq(renderBlockOf({ moderationStatus: 'pending', readiness: ready }), null);
});

check('готовность не загрузилась — кнопку не гасим (решает сервер)', () => {
  eq(renderBlockOf({ moderationStatus: 'approved', readiness: null }), null);
  eq(
    renderBlockOf({ moderationStatus: undefined, readiness: undefined }),
    null
  );
});

check('ролик в работе — только pending и processing', () => {
  eq(isVideoBusy('pending'), true);
  eq(isVideoBusy('processing'), true);
  eq(isVideoBusy('complete'), false);
  eq(isVideoBusy('failed'), false);
  eq(isVideoBusy(undefined), false);
});

// ── Аудит S2: озвучка не легла ──

const done = (voiceStatus?: string, postStatus?: string) => ({
  status: 'complete',
  voiceStatus,
  postStatus,
});
const grok = (
  voiceKind: Parameters<typeof voiceTrackIssue>[1]['voiceKind']
) => ({
  voiceKind,
  presenter: 'grok',
});

check('озвучка: failed — плашка с «Переозвучить» при любом голосе', () => {
  for (const k of ['clone', 'soniox', 'preset', 'default', null] as const) {
    eq(voiceTrackIssue(done('failed'), grok(k)), {
      kind: 'failed',
      canRevoice: true,
    });
  }
  // Hedra: речь аватара — до рендера; дорожка поверх дала бы вторую речь.
  eq(
    voiceTrackIssue(done('failed'), {
      voiceKind: 'soniox',
      presenter: 'hedra',
    }),
    {
      kind: 'failed',
      canRevoice: false,
    }
  );
});

check('озвучка: skipped — тревога только когда наша речь единственная', () => {
  eq(voiceTrackIssue(done('skipped'), grok('soniox')), {
    kind: 'skipped',
    canRevoice: false,
  });
  eq(voiceTrackIssue(done('skipped'), grok('clone')), {
    kind: 'skipped',
    canRevoice: false,
  });
  // Пресет и голос по умолчанию звучат без нашей дорожки; голос не прочитан —
  // не утверждаем; Hedra — речь у аватара.
  eq(voiceTrackIssue(done('skipped'), grok('preset')), null);
  eq(voiceTrackIssue(done('skipped'), grok('default')), null);
  eq(voiceTrackIssue(done('skipped'), grok(null)), null);
  eq(
    voiceTrackIssue(done('skipped'), {
      voiceKind: 'soniox',
      presenter: 'hedra',
    }),
    null
  );
});

check('озвучка: не готов, идёт постобработка, всё легло — плашки нет', () => {
  eq(voiceTrackIssue(done('synthesized'), grok('soniox')), null);
  eq(voiceTrackIssue(done(undefined), grok('soniox')), null);
  eq(voiceTrackIssue(done('failed', 'pending'), grok('soniox')), null);
  eq(
    voiceTrackIssue(
      { status: 'processing', voiceStatus: 'failed' },
      grok('soniox')
    ),
    null
  );
  eq(
    voiceTrackIssue(
      { status: 'failed', voiceStatus: 'failed' },
      grok('soniox')
    ),
    null
  );
  eq(voiceTrackIssue(undefined, grok('soniox')), null);
});

check('опрос: после «Переозвучить» ждёт конца постобработки', () => {
  // Без переозвучки — как `isTerminal`: готов/провален — стоп.
  eq(pollSettled(done(undefined, 'pending'), false), true);
  eq(pollSettled({ status: 'failed' }, false), true);
  eq(pollSettled({ status: 'processing' }, false), false);
  eq(pollSettled({ status: 'pending' }, true), false);
  eq(pollSettled(null, false), false);
  // С переозвучкой — только когда `postStatus` ушёл из `pending`.
  eq(pollSettled(done(undefined, 'pending'), true), false);
  eq(pollSettled(done('synthesized', 'complete'), true), true);
  eq(pollSettled(done('failed', 'failed'), true), true);
});

check('старт: отказ из-за голоса ведёт к карточке голоса', () => {
  eq(isVoiceStartError('GREETING_SONIOX_UNAVAILABLE'), true);
  eq(isVoiceStartError('GREETING_SONIOX_VOICE_UNKNOWN'), true);
  eq(isVoiceStartError('GREETING_AVATAR_SPEECH_FAILED'), true);
  eq(isVoiceStartError('GREETING_SCRIPT_STALE'), false);
  eq(isVoiceStartError(null), false);
  // Коды — настоящие коды сервера, а не опечатки.
  const codes = readFileSync(
    new URL('../../backend/src/common/greeting-errors.ts', import.meta.url),
    'utf8'
  );
  for (const c of VOICE_START_ERROR_CODES)
    if (!codes.includes(`${c}: '${c}'`)) throw new Error(`нет кода ${c}`);
});

check('проба Soniox уходит с языком поздравления', () => {
  const step = readFileSync(
    new URL(
      '../src/features/projects/greeting/SenderVoiceStep.tsx',
      import.meta.url
    ),
    'utf8'
  );
  if (!/provider: 'soniox',\s*language,/.test(step))
    throw new Error('previewVoice без language');
  const api = readFileSync(
    new URL('../src/services/projects-api.ts', import.meta.url),
    'utf8'
  );
  if (!api.includes('{ language: options.language }'))
    throw new Error('language не уходит в POST /tts/preview');
});

console.log(failed ? `\n${failed} провалено` : `\n${passed} проверок пройдено`);
if (failed) process.exit(1);
