/**
 * Ротация голосовых подсказок живого эфира — единственная логика плеера,
 * ошибка в которой называет участнику торгов НЕВЕРНУЮ ЦЕНУ.
 *
 * Появился после аудита `docs-tz/AUDIT-Live-Auction-Player.md` (находка
 * L-1): реплика `BID_STATS` — это «Новая ставка — <сумма>» с суммой,
 * впечатанной в аудио при генерации. До правки плеер проигрывал новому
 * зрителю весь накопленный плейлист таких реплик, в обратном
 * хронологическом порядке — то есть заканчивал самой низкой ценой из
 * истории ровно перед тем, как человек решал, сколько ставить.
 *
 * Тест проверялся на «обратном ходу»: прогнанный против логики ДО
 * правки, он падает на первой же проверке.
 *
 * Запуск: `npm test` в marketplace (та же конвенция, что во frontend).
 */

import assert from 'node:assert/strict';
import {
  createRotationState,
  pendingBidStatsSeq,
  pickNextCue,
  PLAYED_LOG_CAP,
  seedPlayed,
  type RotationCue,
} from '../src/lib/live-cue-rotation';

let passed = 0;
function it(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

const cue = (seq: number, kind: string): RotationCue => ({
  id: `c${seq}`,
  seq,
  kind,
  audioUrl: `https://blob/${seq}.mp3`,
});

/** Детерминированное «перемешивание» — порядок как есть. */
const noShuffle = <T,>(arr: readonly T[]): T[] => [...arr];

console.log('ротация подсказок живого эфира');

it('L-1: подсказки, лежавшие в плейлисте при подключении, НЕ проигрываются', () => {
  // Зритель открыл страницу горячего лота: в плейлисте уже 12 ставок.
  const history = Array.from({ length: 12 }, (_, i) => cue(i + 1, 'BID_STATS'));
  const cues = [...history, cue(90, 'LOT_DESC'), cue(91, 'INVITE')];

  const st = createRotationState();
  seedPlayed(st, cues);

  for (let i = 0; i < 20; i++) {
    const next = pickNextCue(st, cues, noShuffle);
    assert.notEqual(next?.kind, 'BID_STATS', `на шаге ${i} прозвучала историческая ставка ${next?.seq}`);
  }
});

it('L-1: ставка, появившаяся ПОСЛЕ подключения, звучит', () => {
  const cues = [cue(1, 'BID_STATS'), cue(90, 'LOT_DESC')];
  const st = createRotationState();
  seedPlayed(st, cues);

  assert.equal(pickNextCue(st, [...cues, cue(2, 'BID_STATS')], noShuffle)?.seq, 2);
});

it('L-1: из нескольких новых ставок звучит только САМАЯ СВЕЖАЯ, прежние отбрасываются', () => {
  const base = [cue(90, 'LOT_DESC')];
  const st = createRotationState();
  seedPlayed(st, base);

  // За один тик прилетело три ставки подряд — на горячем лоте обычное дело.
  const cues = [...base, cue(10, 'BID_STATS'), cue(11, 'BID_STATS'), cue(12, 'BID_STATS')];
  assert.equal(pickNextCue(st, cues, noShuffle)?.seq, 12, 'должна прозвучать последняя ставка');

  // Прежние не должны всплыть следующими ходами: именно это делало голос
  // «обратным по времени» и называло уже перебитую цену.
  for (let i = 0; i < 5; i++) {
    const next = pickNextCue(st, cues, noShuffle);
    assert.notEqual(next?.kind, 'BID_STATS', `отброшенная ставка ${next?.seq} всё-таки прозвучала`);
  }
});

it('L-6: признак «есть непрозвучавшая ставка» гаснет после выбора — цикла не будет', () => {
  const base = [cue(90, 'LOT_DESC')];
  const st = createRotationState();
  seedPlayed(st, base);

  const cues = [...base, cue(10, 'BID_STATS')];
  assert.equal(pendingBidStatsSeq(st, cues), 10);
  pickNextCue(st, cues, noShuffle);
  assert.equal(pendingBidStatsSeq(st, cues), null, 'признак остался — эффект зациклится');
});

it('pregen-подсказки идут по кругу и круг пересобирается при смене набора', () => {
  const st = createRotationState();
  const cues = [cue(90, 'LOT_DESC'), cue(91, 'INVITE'), cue(92, 'PRAISE')];
  seedPlayed(st, cues);

  assert.deepEqual(
    [0, 1, 2, 3].map(() => pickNextCue(st, cues, noShuffle)?.seq),
    [90, 91, 92, 90],
    'круг должен замыкаться',
  );

  const more = [...cues, cue(93, 'PRAISE')];
  const seen = new Set([0, 1, 2, 3].map(() => pickNextCue(st, more, noShuffle)?.seq));
  assert.ok(seen.has(93), 'новая pregen-подсказка так и не попала в круг');
});

it('пустой плейлист и плейлист без pregen не роняют выбор', () => {
  const st = createRotationState();
  assert.equal(pickNextCue(st, [], noShuffle), null);

  const onlyOldBids = [cue(1, 'BID_STATS')];
  seedPlayed(st, onlyOldBids);
  assert.equal(pickNextCue(st, onlyOldBids, noShuffle), null, 'нечего играть — должен быть null');
});

it('журнал проигранного не растёт бесконечно', () => {
  const st = createRotationState();
  const pregen = [cue(900000, 'LOT_DESC')];
  for (let i = 1; i <= PLAYED_LOG_CAP + 50; i++) {
    pickNextCue(st, [...pregen, cue(i, 'BID_STATS')], noShuffle);
  }
  assert.ok(st.played.size <= PLAYED_LOG_CAP, `журнал разросся до ${st.played.size}`);
});

it('seedPlayed идемпотентна: второй вызов не глушит новые ставки', () => {
  const st = createRotationState();
  seedPlayed(st, [cue(1, 'BID_STATS')]);
  // Второй набор пришёл первым тиком опроса — история уже засеяна, и
  // новая ставка глушиться не должна.
  seedPlayed(st, [cue(1, 'BID_STATS'), cue(2, 'BID_STATS')]);
  assert.equal(pendingBidStatsSeq(st, [cue(2, 'BID_STATS')]), 2);
});

console.log(`\nротация: ${passed} проверок пройдено`);
