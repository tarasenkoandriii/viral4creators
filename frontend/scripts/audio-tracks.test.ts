import assert from 'node:assert/strict';
import {
  buildable,
  isDownloadable,
  needsPolling,
  offersVoice,
  panelAccess,
  subtitlesFileName,
  subtitlesHref,
  trackState,
  type AudioTrackView,
  type AudioTracksResult,
} from '../src/lib/audio-tracks';

const track = (over: Partial<AudioTrackView> = {}): AudioTrackView => ({
  id: 't1',
  locale: 'de',
  status: 'READY',
  speech: 'Steel mug',
  trackUrl: 'https://blob/track.m4a',
  voiceUrl: 'https://blob/voice.mp3',
  subtitlesSrt: null,
  mixing: false,
  stale: false,
  voiceSeconds: 6,
  overflowSeconds: -1,
  tempoRate: null,
  attempts: 1,
  note: null,
  mixError: null,
  uploadedAt: null,
  uploadedById: null,
  ...over,
});

// Порядок проверок важнее самих проверок. «Устаревшая» первой: у
// дорожки от прежней версии ролика «готова» — враньё худшее, чем
// молчание, и заливать её нельзя, хотя файл на месте.
assert.equal(trackState(track()), 'ready');
assert.equal(trackState(track({ stale: true })), 'stale');
assert.equal(trackState(track({ stale: true, mixing: true })), 'stale');
assert.equal(trackState(track({ mixing: true })), 'mixing');
assert.equal(trackState(track({ status: 'HANDOVER' })), 'handover');
assert.equal(trackState(track({ status: 'FAILED' })), 'failed');
assert.equal(trackState(track({ trackUrl: null })), 'voiceOnly');
// Собирается — важнее «готова»: файл ещё от прошлой сборки.
assert.equal(trackState(track({ mixing: true, status: 'READY' })), 'mixing');

// Заливать можно только по-настоящему готовую.
assert.equal(isDownloadable(track()), true);
assert.equal(isDownloadable(track({ stale: true })), false);
assert.equal(isDownloadable(track({ mixing: true })), false);
assert.equal(isDownloadable(track({ trackUrl: null })), false);

// Опрашиваем, только пока что-то собирается: экран, опрашивающий
// вечно, тратит чужой ffmpeg на каждом открытом окне, а узнать ему уже
// нечего.
const result = (tracks: AudioTrackView[]): AudioTracksResult => ({
  sourceLocale: 'ru',
  toBuild: [],
  tracks,
});
assert.equal(needsPolling(null), false);
assert.equal(needsPolling(result([])), false);
assert.equal(needsPolling(result([track()])), false);
assert.equal(needsPolling(result([track(), track({ mixing: true })])), true);

// Список языков считает сервер; здесь защита от пустого ответа —
assert.deepEqual(buildable(null), []);
assert.deepEqual(buildable({ ...result([]), toBuild: ['de', 'en'] }), [
  'de',
  'en',
]);
// — и от языка, сборка которого уже идёт: сервер считает его
// недостающим («задача есть, файла нет» для него неотличимо от «файла
// нет вовсе»), и без этого рядом оказались бы строка «собирается» и
// кнопка «Собрать» на тот же язык, а «собрать недостающие» оплатила бы
// вторую сборку того же.
assert.deepEqual(
  buildable({
    ...result([track({ locale: 'de', mixing: true, trackUrl: null })]),
    toBuild: ['de', 'en'],
  }),
  ['en']
);
// Неудавшуюся и устаревшую собрать заново — можно и нужно.
assert.deepEqual(
  buildable({
    ...result([
      track({ locale: 'de', status: 'FAILED', trackUrl: null }),
      track({ locale: 'en', stale: true }),
    ]),
    toBuild: ['de', 'en'],
  }),
  ['de', 'en']
);

// Субтитры приходят текстом, поэтому отдаём их `data:`-ссылкой — её,
// в отличие от `blob:`, не нужно отзывать.
const srt = '1\n00:00:00,000 --> 00:00:02,000\nSteel mug\n';
const href = subtitlesHref(track({ subtitlesSrt: srt }));
assert.ok(href && href.startsWith('data:text/plain;charset=utf-8,'));
assert.equal(
  decodeURIComponent(href!.slice('data:text/plain;charset=utf-8,'.length)),
  srt
);
assert.equal(subtitlesHref(track()), null);
// Устаревшая закрывает и субтитры: они размечены по хронометражу
// ПРЕЖНЕЙ версии ролика и разъедутся с картинкой, выглядя исправными.
assert.equal(subtitlesHref(track({ subtitlesSrt: srt, stale: true })), null);
assert.equal(subtitlesFileName(track({ locale: 'es' })), 'es.srt');

// Право СОБИРАТЬ не должно закрывать ПРОСМОТР уже собранного — аудит
// этапа 148 нашёл эту ошибку дважды подряд (А-1 и А-6).
const access = (over: Partial<Parameters<typeof panelAccess>[0]> = {}) =>
  panelAccess({
    videoReady: true,
    planLoading: false,
    planFailed: false,
    allowed: true,
    hasTracks: true,
    ...over,
  });
assert.equal(access(), 'full');
// Premium и НИ ОДНОЙ дорожки — самый первый заход, ради которого всё и
// делалось: полная панель, а не замок (мутация «full требует дорожек»
// выжила без этой строки).
assert.equal(access({ hasTracks: false }), 'full');
// Постобработка ещё идёт: дорожку считают от ТЕКУЩЕЙ версии ролика, а
// она сейчас меняется.
assert.equal(access({ videoReady: false }), 'hidden');
assert.equal(access({ videoReady: false, allowed: false }), 'hidden');
// Матрица ещё грузится — честнее не рисовать ни кнопку, ни замок, чем
// мигнуть замком у премиум-пользователя.
assert.equal(access({ planLoading: true, allowed: false }), 'hidden');
// А-1: без Premium, но с собранными дорожками — список и замок вместо
// кнопок, а не замок вместо всего. Сервер отдаёт список без проверки
// права именно ради этого.
assert.equal(access({ allowed: false }), 'locked-list');
assert.equal(access({ allowed: false, hasTracks: false }), 'locked');
// А-6: матрица НЕ ЗАГРУЗИЛАСЬ — это не «ещё грузится». Дорожки
// показываем, но замок не рисуем: его подпись была бы выдумкой.
assert.equal(
  access({ planLoading: true, planFailed: true, allowed: false }),
  'list'
);
assert.equal(
  access({
    planLoading: true,
    planFailed: true,
    allowed: false,
    hasTracks: false,
  }),
  'hidden'
);
// Упавшая матрица не перебивает незавершённую постобработку.
assert.equal(
  access({ videoReady: false, planLoading: true, planFailed: true }),
  'hidden'
);

// Голос — запасной выход, а не второй файл рядом с готовой дорожкой:
// это речь без подложки, и залитый вместо дорожки он даёт ролик без
// фона (А-4).
assert.equal(offersVoice(track()), false);
assert.equal(offersVoice(track({ trackUrl: null })), true);
assert.equal(offersVoice(track({ status: 'FAILED', trackUrl: null })), true);
assert.equal(offersVoice(track({ trackUrl: null, voiceUrl: null })), false);
// У устаревшей закрыт и голос — он от прежнего ролика.
assert.equal(offersVoice(track({ stale: true, trackUrl: null })), false);
assert.equal(offersVoice(track({ stale: true })), false);

console.log('audio-tracks: ok');
