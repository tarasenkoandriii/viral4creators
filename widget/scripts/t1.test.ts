/**
 * Т-1 (§5-бис.12), уровень «юнит»: конвейер фикстур без сети — WAV туда и
 * обратно, SNR смеси точно в заданных дБ, детерминизм (тот же набор —
 * те же байты), детектор речи слышит команду при SNR 20/10 дБ и кончает
 * фразу тишиной; порог перебивания (`boost`) глушит свою озвучку; мок-
 * синтез набора small даёт файлы ожиданий; WER и «смысл сохранён».
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import { liveModelOn, liveModelPlan } from '../e2e/stand/live-model';

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

  // Заход 9: уровень `transcript-live` — без ключа понятный отказ (код 2,
  // e2e не запускается); с ключом — тот же промпт/разбор, что у сервера.
  {
    const env = { ...process.env };
    delete env.GEMINI_API_KEY;
    delete env.GOOGLE_GEMINI_API_KEY;
    const r = spawnSync(
      process.execPath,
      [path.join('scripts', 't1', 'run.mjs'), 'transcript-live'],
      { env, encoding: 'utf8', cwd: process.cwd() }
    );
    assert.equal(r.status, 2, 'без ключа — код 2');
    assert.match(
      r.stderr,
      /transcript-live — у владельца: нужен GEMINI_API_KEY/
    );
    assert.doesNotMatch(r.stdout, /e2e /, 'без ключа e2e не запускается');
    const bad = spawnSync(
      process.execPath,
      [path.join('scripts', 't1', 'run.mjs'), 'no-such-level'],
      { env, encoding: 'utf8', cwd: process.cwd() }
    );
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /transcript-live/);

    assert.equal(
      liveModelOn({ T1_LIVE_MODEL: '1' }),
      false,
      'без ключа — фикстуры'
    );
    assert.equal(
      liveModelOn({ GEMINI_API_KEY: 'k' }),
      false,
      'без флага — фикстуры'
    );
    assert.equal(
      liveModelOn({ T1_LIVE_MODEL: '1', GEMINI_API_KEY: 'k' }),
      true
    );
    const calls: Array<{
      url: string;
      headers: Record<string, string>;
      body: string;
    }> = [];
    const answer = (text: string, ok = true) =>
      (async (
        url: string,
        init: { headers: Record<string, string>; body: string }
      ) => {
        calls.push({ url, headers: init.headers, body: init.body });
        return {
          ok,
          status: ok ? 200 : 500,
          json: async () => ({
            candidates: [{ content: { parts: [{ text }] } }],
          }),
        };
      }) as never;
    const snapshot = {
      url: 'https://shop.example.localhost/',
      title: 'Стенд',
      elements: [
        {
          ref: 'e1',
          role: 'link',
          tag: 'a',
          text: 'Доставка',
          hiddenLabel: null,
          assistId: null,
          inputType: null,
          href: 'https://shop.example.localhost/delivery',
          disabled: false,
          checked: null,
          selected: null,
          options: [],
          heading: null,
          submit: false,
          inForm: false,
          confirmZone: false,
          pd: false,
          toggle: false,
          gesture: null,
          inView: true,
        },
      ],
    };
    const env2 = {
      GEMINI_API_KEY: 'secret-k',
      GEMINI_MODEL: 'gemini-x',
    } as NodeJS.ProcessEnv;
    const steps = await liveModelPlan(
      { text: 'відкрий доставку', snapshot: snapshot as never, lang: 'uk' },
      env2,
      answer('{"command": true, "steps": [{"kind": "click", "target": "e1"}]}')
    );
    assert.deepEqual(steps, [{ kind: 'click', target: 'e1' }]);
    assert.match(calls[0].url, /\/models\/gemini-x:generateContent$/);
    assert.ok(!calls[0].url.includes('secret-k'), 'ключ — не в адресе');
    assert.equal(calls[0].headers['x-goog-api-key'], 'secret-k');
    const sent = JSON.parse(calls[0].body);
    assert.equal(sent.generationConfig.temperature, 0);
    assert.equal(sent.generationConfig.responseMimeType, 'application/json');
    assert.match(sent.contents[0].parts[0].text, /Доставка/);
    assert.match(sent.contents[0].parts[0].text, /відкрий доставку/);
    assert.equal(
      await liveModelPlan(
        { text: 'привіт', snapshot: snapshot as never, lang: 'uk' },
        env2,
        answer('{"command": false, "steps": []}')
      ),
      'not_command'
    );
    assert.equal(
      await liveModelPlan(
        { text: 'x', snapshot: snapshot as never, lang: 'uk' },
        env2,
        answer('не JSON')
      ),
      null
    );
    assert.equal(
      await liveModelPlan(
        { text: 'x', snapshot: snapshot as never, lang: 'uk' },
        env2,
        answer('{}', false)
      ),
      null
    );
  }

  console.log(
    't1: WAV, SNR, детерминизм, детектор речи, перебивание, фикстуры, WER, transcript-live (отказ без ключа, промпт сервера) — ok'
  );
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
