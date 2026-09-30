// Plain assertions runnable with `npx tsx scripts/voice-sample.test.ts`.
//
// Образец голоса для клонирования (Resemble): WAV в браузере и
// нормализация типа. Прод-дефект 30.09.2026 — Telegram Android слал
// `audio/webm;codecs=opus`, сервер сверял голые типы и отвечал
// английским «mimeType must be one of…»; плеер показывал «18:19».

import { readFileSync } from 'node:fs';
import {
  audioToWav,
  downmixToMono,
  encodeWavPcm16,
  resampleLinear,
  VOICE_SAMPLE_MAX_SEC,
  VOICE_SAMPLE_PROVIDER_MAX_SEC,
  WAV_HEADER_BYTES,
  wavTargetRate,
  type DecodedAudioLike,
} from '../src/lib/wav';
import {
  fmtDuration,
  isAcceptedVoiceSampleMime,
  MIME_ALIASES,
  mimeFromFileName,
  normalizeAudioMime,
  DECODE_UNKNOWN_MAX_BYTES,
  prepareVoiceSample,
  type PreparedVoiceSample,
  VOICE_SAMPLE_MAX_BYTES,
  VOICE_SAMPLE_MIME_TYPES,
} from '../src/lib/voice-sample';

let failed = 0;
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
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
function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
const ascii = (v: DataView, off: number, len: number) =>
  String.fromCharCode(
    ...Array.from({ length: len }, (_, i) => v.getUint8(off + i))
  );

function fakeAudio(
  rate: number,
  seconds: number,
  channels = 1,
  value = (ch: number, i: number) => Math.sin(i / 10) * (ch + 1) * 0.3
): DecodedAudioLike {
  const len = Math.round(rate * seconds);
  const data = Array.from({ length: channels }, (_, ch) => {
    const a = new Float32Array(len);
    for (let i = 0; i < len; i++) a[i] = value(ch, i);
    return a;
  });
  return {
    sampleRate: rate,
    numberOfChannels: channels,
    getChannelData: (c) => data[c],
  };
}

/** В тестах отмены нет — `null` здесь означал бы ошибку. */
async function prep(
  ...args: Parameters<typeof prepareVoiceSample>
): Promise<PreparedVoiceSample> {
  const p = await prepareVoiceSample(...args);
  if (!p) throw new Error('подготовка вернула null без отмены');
  return p;
}

const serverDto = readFileSync(
  new URL(
    '../../backend/src/modules/user-voices/dto/user-voices.dto.ts',
    import.meta.url
  ),
  'utf8'
);

async function main() {
  console.log('voice-sample (образец голоса → WAV, тип без кодека)');

  await check('заголовок WAV: RIFF/WAVE, PCM, моно, 16 бит, размеры', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const buf = encodeWavPcm16(samples, 44100);
    const v = new DataView(buf);
    eq(buf.byteLength, WAV_HEADER_BYTES + samples.length * 2);
    eq(ascii(v, 0, 4), 'RIFF');
    eq(v.getUint32(4, true), buf.byteLength - 8);
    eq(ascii(v, 8, 4), 'WAVE');
    eq(ascii(v, 12, 4), 'fmt ');
    eq(v.getUint32(16, true), 16);
    eq(v.getUint16(20, true), 1); // PCM
    eq(v.getUint16(22, true), 1); // моно
    eq(v.getUint32(24, true), 44100);
    eq(v.getUint32(28, true), 44100 * 2);
    eq(v.getUint16(32, true), 2);
    eq(v.getUint16(34, true), 16);
    eq(ascii(v, 36, 4), 'data');
    eq(v.getUint32(40, true), samples.length * 2);
    eq(
      [0, 1, 2, 3, 4].map((i) => v.getInt16(44 + i * 2, true)),
      [0, 16384, -16384, 32767, -32768]
    );
  });

  await check('выход за [-1, 1] и NaN не ломают PCM', () => {
    const v = new DataView(
      encodeWavPcm16(new Float32Array([2, -3, NaN]), 22050)
    );
    eq(
      [0, 1, 2].map((i) => v.getInt16(44 + i * 2, true)),
      [32767, -32768, 0]
    );
  });

  await check('стерео сводится в моно средним', () => {
    eq(
      Array.from(
        downmixToMono([new Float32Array([1, 0.5]), new Float32Array([0, 0.5])])
      ),
      [0.5, 0.5]
    );
  });

  await check('частота: 48 кГц → 44,1; 16 кГц вверх не тянем', () => {
    eq(wavTargetRate(48000), 44100);
    eq(wavTargetRate(44100), 44100);
    eq(wavTargetRate(16000), 16000);
    eq(resampleLinear(new Float32Array(48000), 48000, 44100).length, 44100);
  });

  await check('audioToWav: 30 с стерео 48 кГц → моно 44,1 кГц, 30 с', () => {
    const r = audioToWav(fakeAudio(48000, 30, 2));
    eq(r.sampleRate, 44100);
    ok(Math.abs(r.durationSec - 30) < 0.01, `duration ${r.durationSec}`);
    eq(r.trimmed, false);
    const v = new DataView(r.wav);
    eq(v.getUint16(22, true), 1);
    eq(v.getUint32(24, true), 44100);
  });

  await check(
    'длиннее потолка — обрезка до 2:00, и WAV влезает в 15 МБ',
    () => {
      const r = audioToWav(fakeAudio(48000, 150, 2, () => 0.1));
      eq(r.trimmed, true);
      ok(
        Math.abs(r.durationSec - VOICE_SAMPLE_MAX_SEC) < 0.01,
        `duration ${r.durationSec}`
      );
      ok(Math.abs(r.sourceDurationSec - 150) < 0.01, 'source duration');
      ok(r.wav.byteLength < VOICE_SAMPLE_MAX_BYTES, `size ${r.wav.byteLength}`);
    }
  );

  await check('тип: без параметров кодека, нижний регистр, синонимы', () => {
    eq(normalizeAudioMime('audio/webm;codecs=opus'), 'audio/webm');
    eq(normalizeAudioMime(' Audio/MP4; codecs="mp4a.40.2"'), 'audio/mp4');
    eq(normalizeAudioMime('audio/x-m4a'), 'audio/mp4');
    eq(normalizeAudioMime('audio/mp3'), 'audio/mpeg');
    eq(normalizeAudioMime('', 'audio/webm'), 'audio/webm');
    eq(normalizeAudioMime(null, 'audio/webm'), 'audio/webm');
    eq(isAcceptedVoiceSampleMime('audio/webm;codecs=opus'), true);
    eq(isAcceptedVoiceSampleMime('audio/ogg;codecs=opus'), false);
    eq(mimeFromFileName('Голос.M4A'), 'audio/mp4');
    eq(mimeFromFileName('x.mp3'), 'audio/mpeg');
    eq(mimeFromFileName('noext'), '');
  });

  await check('список типов и синонимы — те же, что на сервере', () => {
    const list = serverDto.match(/ALLOWED_MIME_TYPES\s*=\s*\[([\s\S]*?)\]/);
    if (!list) throw new Error('ALLOWED_MIME_TYPES не найден');
    eq(
      [...list[1].matchAll(/'([^']+)'/g)].map((x) => x[1]),
      [...VOICE_SAMPLE_MIME_TYPES]
    );
    const al = serverDto.match(/MIME_ALIASES[^=]*=\s*\{([\s\S]*?)\}/);
    if (!al) throw new Error('MIME_ALIASES не найден');
    const server: Record<string, string> = {};
    for (const m of al[1].matchAll(/'([^']+)':\s*'([^']+)'/g))
      server[m[1]] = m[2];
    eq(server, MIME_ALIASES);
    ok(
      /@Transform\(/.test(serverDto),
      'сервер должен нормализовать тип до проверки'
    );
  });

  await check(
    'prepare: декодировалось — уходит WAV с длительностью',
    async () => {
      const src = new Blob([new Uint8Array(10)], {
        type: 'audio/webm;codecs=opus',
      });
      const p = await prep(src, 'audio/webm;codecs=opus', {
        decoder: async () => fakeAudio(44100, 42),
      });
      eq(p.mime, 'audio/wav');
      eq(p.converted, true);
      eq(p.unsupported, false);
      eq(Math.round(p.durationSec ?? 0), 42);
      eq(p.blob.type, 'audio/wav');
      const head = new DataView(await p.blob.arrayBuffer());
      eq(ascii(head, 0, 4), 'RIFF');
    }
  );

  await check(
    'prepare: не декодировалось — исходник под голым типом',
    async () => {
      const src = new Blob([new Uint8Array(10)], {
        type: 'audio/webm;codecs=opus',
      });
      const p = await prep(src, 'audio/webm;codecs=opus', {
        decoder: async () => {
          throw new Error('EncodingError');
        },
      });
      eq(p.mime, 'audio/webm');
      eq(p.converted, false);
      eq(p.unsupported, false);
      eq(p.durationSec, null);
      ok(p.blob === src, 'исходник должен уйти как есть');
    }
  );

  await check(
    'prepare: ogg без декодера — помечен как неподдерживаемый',
    async () => {
      const src = new Blob([new Uint8Array(10)], { type: 'audio/ogg' });
      const p = await prep(src, 'audio/ogg;codecs=opus', {
        decoder: null,
      });
      eq(p.mime, 'audio/ogg');
      eq(p.unsupported, true);
    }
  );

  await check(
    'prepare: пустой декодированный звук — не WAV из 44 байт',
    async () => {
      const src = new Blob([new Uint8Array(10)], { type: 'audio/mp4' });
      const p = await prep(src, 'audio/mp4', {
        decoder: async () => fakeAudio(44100, 0),
      });
      eq(p.converted, false);
      eq(p.mime, 'audio/mp4');
    }
  );

  await check('автостоп на 2:00 с хвостом < 1 с — не «обрезали»', () => {
    const a = audioToWav(
      fakeAudio(44100, VOICE_SAMPLE_MAX_SEC + 0.5, 1, () => 0.1)
    );
    eq(a.trimmed, false);
    ok(
      Math.abs(a.durationSec - VOICE_SAMPLE_MAX_SEC) < 0.01,
      'режется до потолка'
    );
    eq(
      audioToWav(fakeAudio(44100, VOICE_SAMPLE_MAX_SEC + 1.5, 1, () => 0.1))
        .trimmed,
      true
    );
  });

  await check('каналы обрезаются ДО сведения в моно (память WebView)', () => {
    const src = readFileSync(
      new URL('../src/lib/wav.ts', import.meta.url),
      'utf8'
    );
    const body = src.slice(src.indexOf('export function audioToWav('));
    const sub = body.indexOf('.subarray(0, maxSamples)');
    const mix = body.indexOf('downmixToMono(');
    ok(
      sub > 0 && mix > 0 && sub < mix,
      'subarray должен стоять до downmixToMono'
    );
    // и результат при этом тот же: разные длины каналов, стерео 150 с
    const r = audioToWav(fakeAudio(48000, 150, 2, () => 0.2));
    ok(Math.abs(r.durationSec - VOICE_SAMPLE_MAX_SEC) < 0.01, 'длительность');
    ok(Math.abs(r.sourceDurationSec - 150) < 0.01, 'исходная длительность');
  });

  const neverDecode = async (): Promise<DecodedAudioLike> => {
    throw new Error('декодер не должен вызываться');
  };
  let decodeCalls = 0;
  const countingDecoder = (sec: number) => async () => {
    decodeCalls++;
    return fakeAudio(44100, sec);
  };

  await check(
    'длиннее 3 минут по счётчику записи — tooLong без декодирования',
    async () => {
      decodeCalls = 0;
      const p = await prep(
        new Blob([new Uint8Array(10)], { type: 'audio/webm' }),
        'audio/webm',
        {
          knownDurationSec: VOICE_SAMPLE_PROVIDER_MAX_SEC + 20,
          decoder: countingDecoder(200),
          probe: null,
        }
      );
      eq(p.tooLong, true);
      eq(p.converted, false);
      eq(decodeCalls, 0);
    }
  );

  await check(
    'длиннее 3 минут по метаданным файла — tooLong без декодирования',
    async () => {
      decodeCalls = 0;
      const p = await prep(
        new Blob([new Uint8Array(10)], { type: 'audio/mpeg' }),
        'audio/mpeg',
        {
          decoder: countingDecoder(600),
          probe: async () => 18 * 60,
        }
      );
      eq(p.tooLong, true);
      eq(decodeCalls, 0);
    }
  );

  await check(
    '2:30 по метаданным — декодируется и режется до 2:00',
    async () => {
      const p = await prep(
        new Blob([new Uint8Array(10)], { type: 'audio/mpeg' }),
        'audio/mpeg',
        {
          decoder: async () => fakeAudio(44100, 150),
          probe: async () => 150,
        }
      );
      eq(p.tooLong, false);
      eq(p.converted, true);
      eq(p.trimmed, true);
    }
  );

  await check(
    'декодировалось, а исходник > 3 минут — не отправляем',
    async () => {
      const p = await prep(
        new Blob([new Uint8Array(10)], { type: 'audio/mpeg' }),
        'audio/mpeg',
        {
          decoder: async () =>
            fakeAudio(8000, VOICE_SAMPLE_PROVIDER_MAX_SEC + 30),
          probe: async () => null,
        }
      );
      eq(p.tooLong, true);
      eq(p.converted, false);
    }
  );

  await check(
    'длительность неизвестна и файл большой — не декодируем целиком',
    async () => {
      decodeCalls = 0;
      const big = new Blob([new Uint8Array(DECODE_UNKNOWN_MAX_BYTES + 1)], {
        type: 'audio/mpeg',
      });
      const p = await prep(big, 'audio/mpeg', {
        decoder: countingDecoder(5),
        probe: async () => null,
      });
      eq(p.converted, false);
      eq(decodeCalls, 0);
      eq(p.mime, 'audio/mpeg');
      eq(p.tooLong, false);
    }
  );

  await check(
    'не декодировалось — длительность по счётчику записи',
    async () => {
      const p = await prep(
        new Blob([new Uint8Array(10)], { type: 'audio/webm' }),
        'audio/webm;codecs=opus',
        {
          knownDurationSec: 30,
          decoder: neverDecode,
          probe: null,
        }
      );
      eq(p.durationSec, 30);
      eq(p.tooLong, false);
      eq(p.unsupported, false);
    }
  );

  await check(
    'файл без типа и с неизвестным расширением — unsupported, не webm',
    async () => {
      const f = new Blob([new Uint8Array(10)]);
      const p = await prep(f, mimeFromFileName('voice.xyz'), {
        decoder: neverDecode,
        probe: null,
      });
      eq(p.mime, '');
      eq(p.unsupported, true);
    }
  );

  await check('отмена: до и во время декодирования — null', async () => {
    const c1 = new AbortController();
    c1.abort();
    eq(
      await prepareVoiceSample(
        new Blob([new Uint8Array(10)], { type: 'audio/webm' }),
        'audio/webm',
        {
          decoder: async () => fakeAudio(44100, 5),
          probe: null,
          knownDurationSec: 5,
          signal: c1.signal,
        }
      ),
      null
    );
    const c2 = new AbortController();
    eq(
      await prepareVoiceSample(
        new Blob([new Uint8Array(10)], { type: 'audio/webm' }),
        'audio/webm',
        {
          decoder: async () => {
            c2.abort();
            return fakeAudio(44100, 5);
          },
          probe: null,
          knownDurationSec: 5,
          signal: c2.signal,
        }
      ),
      null
    );
    decodeCalls = 0;
    const c3 = new AbortController();
    eq(
      await prepareVoiceSample(
        new Blob([new Uint8Array(10)], { type: 'audio/mpeg' }),
        'audio/mpeg',
        {
          decoder: countingDecoder(5),
          probe: async () => {
            c3.abort();
            return 30;
          },
          signal: c3.signal,
        }
      ),
      null
    );
    eq(decodeCalls, 0);
  });

  await check('уход с экрана отменяет подготовку (оба экрана)', () => {
    for (const f of [
      '../src/features/brand/VoicePicker.tsx',
      '../src/features/persona/PersonaVoice.tsx',
    ]) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      ok(
        /releaseMic\(\);\s*cancelPrepare\(\);\s*\},/.test(src),
        `${f}: размонтирование не зовёт cancelPrepare`
      );
      ok(
        /const cancelPrepare = \(\) => \{\s*prepareGenRef\.current\+\+;\s*prepareAbortRef\.current\?\.abort\(\);/.test(
          src
        ),
        `${f}: cancelPrepare не сдвигает поколение/не отменяет`
      );
      ok(
        /if \(!prepared \|\| gen !== prepareGenRef\.current\) return;/.test(
          src
        ),
        `${f}: поздний результат не отбрасывается`
      );
    }
  });

  await check('длительность для подписи', () => {
    eq(fmtDuration(42.4), '0:42');
    eq(fmtDuration(120), '2:00');
    eq(fmtDuration(-1), '0:00');
  });

  await check(
    'загрузка образца: один нормализованный тип на upload-url и PUT',
    () => {
      for (const [file, fn, put] of [
        [
          '../src/services/projects-api.ts',
          'uploadVoiceSample',
          'putToBlob(target, file, type)',
        ],
        [
          '../src/services/persona-api.ts',
          'uploadPersonaVoiceSample',
          'putPersonaFile(target.uploadUrl, file, type)',
        ],
      ] as const) {
        const src = readFileSync(new URL(file, import.meta.url), 'utf8');
        const body = src.slice(src.indexOf(`function ${fn}(`));
        const end = body.indexOf('\n}\n');
        const fnBody = body.slice(0, end);
        ok(
          /const type = normalizeAudioMime\(mimeType/.test(fnBody),
          `${fn}: тип не нормализуется`
        );
        ok(/mimeType: type,/.test(fnBody), `${fn}: upload-url не с type`);
        ok(fnBody.includes(put), `${fn}: PUT не с type`);
      }
    }
  );

  await check(
    'оба экрана записи готовят образец через prepareVoiceSample',
    () => {
      for (const f of [
        '../src/features/brand/VoicePicker.tsx',
        '../src/features/persona/PersonaVoice.tsx',
      ]) {
        const src = readFileSync(new URL(f, import.meta.url), 'utf8');
        ok(src.includes('prepareVoiceSample('), `${f}: нет prepareVoiceSample`);
        ok(
          !/audio\/ogg;codecs=opus/.test(src),
          `${f}: ogg в кандидатах записи — сервер образцов его не примет`
        );
      }
    }
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
