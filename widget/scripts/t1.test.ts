/**
 * Т-1 (§5-бис.12), уровень «юнит»: конвейер фикстур без сети — WAV туда и
 * обратно, SNR смеси точно в заданных дБ, детерминизм (тот же набор —
 * те же байты), детектор речи слышит команду при SNR 20/10 дБ и кончает
 * фразу тишиной; порог перебивания (`boost`) глушит свою озвучку; мок-
 * синтез набора small даёт файлы ожиданий; WER и «смысл сохранён».
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vad, rms } from '../src/voice/vad';
import {
  MOCK_VOICES,
  RATE,
  concat,
  decodeWav,
  encodeWav,
  mixAtSnr,
  mockSpeech,
  noise,
  silence,
  snrDb,
} from './t1/audio';
import {
  NOISE_ONLY_COUNT,
  buildFixtures,
  commandsOf,
  framed,
  mockProvider,
} from './t1/synth';
import { meaningKept, mockStt, recognizeAll, wer } from './t1/recognize';

/** Прогон детектора речи по сэмплам окнами 50 мс (как чанк voice.js). */
function vadRun(s: Float32Array, boost?: () => number) {
  const v = new Vad({
    minSpeechMs: 400,
    endSilenceMs: 1000,
    maxMs: 30_000,
    boost,
  });
  const win = Math.round(RATE * 0.05);
  let firstSpeech = -1;
  for (let i = 0, t = 0; i + win <= s.length; i += win, t += 50) {
    const step = v.push(rms(s.subarray(i, i + win)), t);
    if (firstSpeech < 0 && v.heardSpeech) firstSpeech = t;
    if (step !== 'listen') return { step, t, firstSpeech, speech: v.speechMs };
  }
  return { step: 'listen' as const, t: -1, firstSpeech, speech: v.speechMs };
}

async function main() {
  // WAV туда и обратно (PCM16: погрешность ≤ 1 шаг квантования).
  {
    const s = mockSpeech('відкрий доставку', MOCK_VOICES[0]);
    const back = decodeWav(encodeWav(s));
    assert.equal(back.rate, RATE);
    assert.equal(back.samples.length, s.length);
    let maxErr = 0;
    for (let i = 0; i < s.length; i++)
      maxErr = Math.max(maxErr, Math.abs(back.samples[i] - s[i]));
    assert.ok(maxErr <= 1 / 32767 + 1e-6, `погрешность ${maxErr}`);
    assert.throws(
      () => decodeWav(Buffer.from('not a wav file at all, nope')),
      /WAV/
    );
  }

  // SNR смеси — заданный (±0.1 дБ) для каждого вида шума; детерминизм.
  {
    const s = framed(mockSpeech('знайди футболку', MOCK_VOICES[2]));
    for (const kind of ['white', 'pink', 'cafe', 'tv', 'keyboard'] as const)
      for (const db of [20, 10, 5]) {
        const { scaledNoise } = mixAtSnr(
          s,
          noise(kind, s.length / RATE, 7),
          db
        );
        assert.ok(
          Math.abs(snrDb(s, scaledNoise) - db) < 0.1,
          `${kind} ${db} дБ: ${snrDb(s, scaledNoise)}`
        );
      }
    const a = encodeWav(mixAtSnr(s, noise('cafe', 3, 5), 10).mix);
    const b = encodeWav(mixAtSnr(s, noise('cafe', 3, 5), 10).mix);
    assert.ok(a.equals(b), 'детерминизм');
    assert.ok(
      !noise('cafe', 1, 5).every((x, i) => x === noise('cafe', 1, 6)[i]),
      'другой seed — другой шум'
    );
  }

  // Детектор речи: команда слышна при SNR 20 и 10 дБ, фраза кончается тишиной.
  {
    for (const v of MOCK_VOICES) {
      const clean = framed(mockSpeech('відкрий доставку будь ласка', v));
      const r = vadRun(clean);
      assert.equal(r.step, 'end', `${v.id}: чистая — конец фразы`);
      assert.ok(
        r.firstSpeech >= 300 && r.firstSpeech <= 800,
        `${v.id}: начало речи ${r.firstSpeech}`
      );
      for (const db of [20, 10]) {
        const { mix } = mixAtSnr(
          clean,
          noise('pink', clean.length / RATE, 3),
          db
        );
        assert.equal(vadRun(mix).step, 'end', `${v.id} SNR ${db}: конец фразы`);
      }
    }
    // Тишина и ровный тихий шум — не фраза.
    assert.equal(vadRun(silence(3)).step, 'listen');
    assert.equal(
      vadRun(noise('white', 3, 9).map((x) => x * 0.02)).step,
      'listen'
    );
  }

  // Порог перебивания: громкая «своя озвучка» при boost ×3 не речь, без — речь.
  {
    const quiet = concat(
      silence(0.5),
      mockSpeech('так', MOCK_VOICES[1]).map((x) => x * 0.15),
      silence(1.5)
    );
    assert.ok(vadRun(quiet).firstSpeech > 0, 'без boost — речь');
    assert.equal(vadRun(quiet, () => 3).firstSpeech, -1, 'boost ×3 — не речь');
  }

  // Мок-синтез набора small: файлы ожиданий и сами файлы.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-fx-'));
    const m = await buildFixtures({
      provider: mockProvider(),
      set: 'small',
      out: dir,
      voices: 2,
    });
    const cmds = commandsOf('small');
    assert.equal(cmds.length, 8);
    assert.equal(m.entries.length, cmds.length * 2 * 4 + NOISE_ONLY_COUNT);
    assert.equal(
      m.entries.filter((e) => e.expect === 'none' && !e.commandId).length,
      NOISE_ONLY_COUNT
    );
    for (const e of m.entries) {
      const w = decodeWav(fs.readFileSync(path.join(dir, e.file)));
      assert.equal(w.rate, RATE);
      assert.ok(Math.abs((w.samples.length / RATE) * 1000 - e.ms) <= 1, e.file);
      if (e.commandId) assert.ok(e.text && e.lang, `${e.file}: текст и язык`);
    }
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')
    );
    assert.equal(saved.entries.length, m.entries.length);
    assert.deepEqual(
      new Set(m.entries.filter((e) => e.snr !== null).map((e) => e.snr)),
      new Set([20, 10, 5])
    );
    // Мок-распознавание: WER 0, смысл сохранён везде.
    const rows = await recognizeAll(dir, mockStt);
    assert.ok(rows.every((r) => r.wer === 0 && r.kept));
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(commandsOf('pr').length, 30);
    assert.equal(commandsOf('full').length, 240);
  }

  // WER и «смысл сохранён».
  {
    assert.equal(wer('відкрий доставку', 'Відкрий доставку.'), 0);
    assert.equal(wer('знайди синю футболку', 'знайди сина футболку'), 1 / 3);
    assert.equal(wer('a b', ''), 1);
    assert.ok(meaningKept('знайди синю футболку', 'знайди синя футболки'));
    assert.ok(!meaningKept('відкрий доставку', 'відкрий кошик'));
    assert.ok(
      !meaningKept('додай 2 футболки', 'додай 3 футболки'),
      'числа — точно'
    );
  }

  console.log(
    't1: WAV, SNR, детерминизм, детектор речи, перебивание, фикстуры, WER — ok'
  );
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
