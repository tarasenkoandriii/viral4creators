// Plain assertions runnable with `npx tsx scripts/story-errors.test.ts`.
//
// Story‑Tales, аудит интерфейсов S2‑1/S3‑1: сообщение сервера из конверта
// HttpExceptionFilter, «ответ не получен» — только без ответа, русские
// подсказки для ошибок микрофона.

import {
  MIC_UNSUPPORTED,
  STORY_FALLBACK,
  STORY_NO_RESPONSE,
  StoryClientError,
  isStoryNoResponse,
  storyErrorCode,
  storyErrorText,
  storyMicErrorText,
  storyMicSupported,
  storyServerMessage,
} from '../src/features/stories/story-errors';

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

/** Как axios: ответ сервера с конвертом HttpExceptionFilter. */
const httpError = (status: number, data: unknown) => ({
  isAxiosError: true,
  message: `Request failed with status code ${status}`,
  response: { status, data },
});
const envelope = (message: unknown, code = 'CONFLICT', details?: object) => ({
  success: false,
  error: { code, message, ...(details ? { details } : {}) },
  meta: { timestamp: 'x', requestId: 'r' },
});

check('server message comes from error.message (filter envelope)', () => {
  const e = httpError(
    400,
    envelope('Лимит: три платных разбора в сутки UTC исчерпан', 'BAD_REQUEST')
  );
  eq(storyServerMessage(e), 'Лимит: три платных разбора в сутки UTC исчерпан');
  eq(
    storyErrorText(e, { fallback: 'Разбор не выполнен.', noResponse: 'нет' }),
    'Лимит: три платных разбора в сутки UTC исчерпан'
  );
});
check(
  'validation arrays are joined; legacy top-level message still read',
  () => {
    eq(
      storyErrorText(httpError(400, envelope(['поле a', 'поле b']))),
      'поле a; поле b'
    );
    eq(
      storyErrorText(httpError(400, { message: 'старый формат' })),
      'старый формат'
    );
  }
);
check('pronunciation 400 from the video quote is shown as is', () => {
  const msg =
    'Произношение не применяется к тексту классической редакции: «Жучка» есть в самой сказке, а она озвучивается точно по изданию.';
  eq(storyErrorText(httpError(400, envelope(msg, 'BAD_REQUEST'))), msg);
});
check('machine code from error.details.code', () => {
  eq(
    storyErrorCode(
      httpError(
        409,
        envelope('Повтор оплачивается заново', 'CONFLICT', {
          code: 'NARRATOR_LOOK_REPEAT_REQUIRED',
        })
      )
    ),
    'NARRATOR_LOOK_REPEAT_REQUIRED'
  );
  eq(storyErrorCode(httpError(409, envelope('x'))), null);
  eq(storyErrorCode(new Error('x')), null);
});
check('response without message → fallback, never "no response"', () => {
  const e = httpError(502, '<html>Bad gateway</html>');
  eq(
    storyErrorText(e, { fallback: 'Свой запасной текст' }),
    'Свой запасной текст'
  );
  ok(!storyErrorText(e).includes('не получен'), storyErrorText(e));
  eq(
    storyErrorText(httpError(429, {})),
    'Слишком много запросов — попробуйте чуть позже.'
  );
  eq(storyErrorText(httpError(418, {})), STORY_FALLBACK);
  eq(isStoryNoResponse(e), false);
});
check('"no response" only for network errors and timeouts', () => {
  const timeout = {
    isAxiosError: true,
    code: 'ECONNABORTED',
    message: 'timeout of 120000ms exceeded',
    request: {},
  };
  const network = {
    isAxiosError: true,
    code: 'ERR_NETWORK',
    message: 'Network Error',
  };
  eq(isStoryNoResponse(timeout), true);
  eq(isStoryNoResponse(network), true);
  eq(storyErrorText(timeout), STORY_NO_RESPONSE);
  eq(
    storyErrorText(network, { noResponse: 'Обновите список' }),
    'Обновите список'
  );
});
check('client-side errors: own text only for StoryClientError', () => {
  eq(
    storyErrorText(
      new StoryClientError('Запись короче секунды — запишите ещё раз')
    ),
    'Запись короче секунды — запишите ещё раз'
  );
  // Чужой английский текст (DOMException и т.п.) человеку не показывается.
  eq(storyErrorText(new Error('Unable to decode audio data')), STORY_FALLBACK);
  eq(storyErrorText(new TypeError('x'), { fallback: 'Своё' }), 'Своё');
  eq(storyErrorText(null), STORY_FALLBACK);
});
check('microphone errors are Russian and point to the permission', () => {
  ok(storyMicErrorText({ name: 'NotAllowedError' }).includes('Telegram'));
  ok(
    storyMicErrorText({ name: 'NotAllowedError' }).includes(
      'Разрешите микрофон'
    )
  );
  ok(storyMicErrorText({ name: 'NotFoundError' }).includes('не найден'));
  ok(storyMicErrorText({ name: 'NotReadableError' }).includes('занят'));
  ok(
    storyMicErrorText({ name: MIC_UNSUPPORTED }).includes('не поддерживается')
  );
  ok(storyMicErrorText(new Error('weird')).includes('аудиофайл'));
  for (const name of ['NotAllowedError', 'NotFoundError', 'X'])
    ok(!/[A-Za-z]{4,}Error/.test(storyMicErrorText({ name })), name);
});
check('microphone support needs getUserMedia and MediaRecorder', () => {
  const gum = () => undefined;
  class Rec {}
  eq(
    storyMicSupported({
      mediaDevices: { getUserMedia: gum },
      MediaRecorder: Rec,
    }),
    true
  );
  eq(storyMicSupported({ mediaDevices: undefined, MediaRecorder: Rec }), false);
  eq(storyMicSupported({ mediaDevices: { getUserMedia: gum } }), false);
  eq(
    storyMicSupported({ mediaDevices: null, MediaRecorder: undefined }),
    false
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
