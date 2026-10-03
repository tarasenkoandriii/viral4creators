/**
 * Т-1 (ТЗ §5-бис.12): конвейер голосовых фикстур — синтез команд набора
 * `e2e/t1/commands.ts`, шумовые варианты и файлы ожиданий.
 *
 *   npx tsx scripts/t1/synth.ts                       # мок-провайдер, набор small → test-results/t1-fixtures
 *   npx tsx scripts/t1/synth.ts --set=pr              # 30 команд PR-набора × голоса мока
 *   SONIOX_API_KEY=… npx tsx scripts/t1/synth.ts --provider=soniox --set=full --out=/путь
 *
 * На каждую команду и язык: чистый файл каждым голосом + по шумовому
 * варианту на каждый SNR (20/10/5 дБ; вид шума — по кругу «кафе/ТВ/
 * клавиатура/розовый») + 30 файлов «только шум» (ожидание — ни одного
 * плана). `manifest.json` — файлы ожиданий: текст, язык, команда, голос,
 * SNR, шум, ожидаемое (`command` — состояние стенда из commands.ts; `none`).
 *
 * Мок-провайдер — без сети (CI): «слоги» вместо речи, распознавание на
 * уровнях «звук» — мок стенда по `manifest` (текст известен). Soniox —
 * настоящий синтез у владельца (ключ — env, в репозитории ключей нет):
 * `POST https://tts-rt.soniox.com/tts` (формы — sites-backend/src/shared/
 * soniox.ts), mp3 → WAV 16 кГц моно через ffmpeg. Записи дикторов (В-31)
 * кладутся рядом вручную с тем же manifest-форматом (`provider: "human"`).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  T1_COMMANDS,
  prSubset,
  type Lang,
  type T1Command,
} from '../../e2e/t1/commands';
import {
  MOCK_VOICES,
  NOISE_KINDS,
  RATE,
  SNR_LEVELS,
  concat,
  decodeWav,
  encodeWav,
  mixAtSnr,
  mockSpeech,
  noise,
  seedOf,
  silence,
  type NoiseKind,
} from './audio';

export type FixtureSet = 'small' | 'pr' | 'full';
export type ProviderName = 'mock' | 'soniox';

export interface FixtureEntry {
  file: string;
  /** id команды набора; null — «только шум». */
  commandId: string | null;
  lang: Lang | null;
  text: string;
  voice: string;
  provider: ProviderName | 'human';
  snr: number | null;
  noise: NoiseKind | null;
  expect: 'command' | 'none';
  /** Длительность, мс (для проверки «команда → первое действие»). */
  ms: number;
}

export interface Manifest {
  version: 1;
  provider: ProviderName;
  set: FixtureSet;
  rate: number;
  entries: FixtureEntry[];
}

export interface TtsProvider {
  name: ProviderName;
  voices: string[];
  synth(text: string, lang: Lang, voice: string): Promise<Float32Array>;
}

/** Мок: детерминированные «слоги» голосом из MOCK_VOICES. */
export function mockProvider(): TtsProvider {
  return {
    name: 'mock',
    voices: MOCK_VOICES.map((v) => v.id),
    async synth(text, _lang, voice) {
      const v = MOCK_VOICES.find((x) => x.id === voice) || MOCK_VOICES[0];
      return mockSpeech(text, v);
    },
  };
}

/**
 * Soniox TTS (владелец; в песочнице сети и ключа нет — код по документации,
 * первый прогон с ключом — первая настоящая проверка). Голоса — env
 * `T1_SONIOX_VOICES` (через запятую), иначе один голос по умолчанию.
 */
export function sonioxProvider(
  env: NodeJS.ProcessEnv = process.env,
  doFetch: typeof fetch = fetch
): TtsProvider {
  const key = env.SONIOX_API_KEY?.trim();
  if (!key) throw new Error('SONIOX_API_KEY не задан');
  const voices = (env.T1_SONIOX_VOICES || 'Maya')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    name: 'soniox',
    voices,
    async synth(text, lang, voice) {
      const res = await doFetch('https://tts-rt.soniox.com/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: 'tts-rt-v2',
          language: lang,
          voice,
          audio_format: 'mp3',
          text,
        }),
      });
      if (!res.ok) throw new Error(`Soniox TTS ответил ${res.status}`);
      return mp3ToPcm(Buffer.from(await res.arrayBuffer()));
    },
  };
}

/** mp3 → PCM16 16 кГц моно (ffmpeg у владельца). */
function mp3ToPcm(mp3: Buffer): Float32Array {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-'));
  const src = path.join(dir, 'in.mp3');
  const dst = path.join(dir, 'out.wav');
  fs.writeFileSync(src, mp3);
  execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-y',
    '-i',
    src,
    '-ac',
    '1',
    '-ar',
    String(RATE),
    '-sample_fmt',
    's16',
    dst,
  ]);
  const { samples } = decodeWav(fs.readFileSync(dst));
  fs.rmSync(dir, { recursive: true, force: true });
  return samples;
}

/** Команды набора: small — 8 (по 2 со стенда), pr — 30, full — все 80 × 3 языка. */
export function commandsOf(
  set: FixtureSet
): Array<{ c: T1Command; lang: Lang }> {
  if (set === 'pr') return prSubset().map(({ c, lang }) => ({ c, lang }));
  if (set === 'full')
    return T1_COMMANDS.flatMap((c) =>
      (['uk', 'ru', 'en'] as const).map((lang) => ({ c, lang }))
    );
  const out: Array<{ c: T1Command; lang: Lang }> = [];
  const langs: Lang[] = ['uk', 'ru', 'en'];
  let k = 0;
  for (const stand of ['react', 'vue', 'jquery', 'mpa'] as const)
    for (const c of T1_COMMANDS.filter(
      (x) => x.stand === stand && !x.negative
    ).slice(0, 2))
      out.push({ c, lang: langs[k++ % 3] });
  return out;
}

/** «Только шум»: 30 файлов (§5-бис.12) — ни одного плана. */
export const NOISE_ONLY_COUNT = 30;

/** Обёртка фразы: 0.5 с тишины до, 2 с после — детектор речи кончит фразу. */
export function framed(speech: Float32Array): Float32Array {
  return concat(silence(0.5), speech, silence(2));
}

export async function buildFixtures(o: {
  provider: TtsProvider;
  set: FixtureSet;
  out: string;
  /** Голосов на команду (мок: все 4; full у владельца — сколько дал провайдер). */
  voices?: number;
}): Promise<Manifest> {
  fs.mkdirSync(o.out, { recursive: true });
  const entries: FixtureEntry[] = [];
  const write = (name: string, s: Float32Array) => {
    fs.writeFileSync(path.join(o.out, name), encodeWav(s));
    return Math.round((s.length / RATE) * 1000);
  };
  const voices = o.provider.voices.slice(
    0,
    o.voices ?? o.provider.voices.length
  );
  let n = 0;
  for (const { c, lang } of commandsOf(o.set)) {
    const text = c.text[lang];
    for (const voice of voices) {
      const clean = framed(await o.provider.synth(text, lang, voice));
      const base = `${c.id}.${lang}.${voice}`;
      entries.push({
        file: `${base}.clean.wav`,
        commandId: c.id,
        lang,
        text,
        voice,
        provider: o.provider.name,
        snr: null,
        noise: null,
        expect: c.negative ? 'none' : 'command',
        ms: write(`${base}.clean.wav`, clean),
      });
      for (const snr of SNR_LEVELS) {
        const kind = NOISE_KINDS[n++ % NOISE_KINDS.length];
        const { mix } = mixAtSnr(
          clean,
          noise(kind, clean.length / RATE, seedOf(base + snr)),
          snr
        );
        const file = `${base}.${kind}${snr}.wav`;
        entries.push({
          file,
          commandId: c.id,
          lang,
          text,
          voice,
          provider: o.provider.name,
          snr,
          noise: kind,
          expect: c.negative ? 'none' : 'command',
          ms: write(file, mix),
        });
      }
    }
  }
  for (let i = 0; i < NOISE_ONLY_COUNT; i++) {
    const kind = NOISE_KINDS[i % NOISE_KINDS.length];
    const file = `noise-${String(i + 1).padStart(2, '0')}.${kind}.wav`;
    entries.push({
      file,
      commandId: null,
      lang: null,
      text: '',
      voice: '-',
      provider: o.provider.name,
      snr: null,
      noise: kind,
      expect: 'none',
      ms: write(file, noise(kind, 3, 1000 + i)),
    });
  }
  const manifest: Manifest = {
    version: 1,
    provider: o.provider.name,
    set: o.set,
    rate: RATE,
    entries,
  };
  fs.writeFileSync(
    path.join(o.out, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
  return manifest;
}

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}

async function main() {
  const providerName = (arg('provider') || 'mock') as ProviderName;
  const set = (arg('set') || 'small') as FixtureSet;
  if (!['small', 'pr', 'full'].includes(set))
    throw new Error(`--set: small|pr|full, не ${set}`);
  const provider =
    providerName === 'soniox' ? sonioxProvider() : mockProvider();
  const out = path.resolve(
    arg('out') || path.join('test-results', 't1-fixtures')
  );
  const voices = arg('voices') ? Number(arg('voices')) : undefined;
  const m = await buildFixtures({ provider, set, out, voices });
  const cmds = m.entries.filter((e) => e.commandId).length;
  console.log(
    `Т-1 фикстуры: ${m.entries.length} файлов (${cmds} команд, ${m.entries.length - cmds} только шум) → ${out}`
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]).endsWith(path.join('scripts', 't1', 'synth.ts'))
) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
