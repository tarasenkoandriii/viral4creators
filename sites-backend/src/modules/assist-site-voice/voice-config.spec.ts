import {
  VOICE_DEFAULTS,
  audioMimeOf,
  defaultVoiceConfig,
  parseVoiceConfig,
  sniffAudio,
  voiceConfigOf,
  voiceDailyCapMicroUsd,
} from './voice-config';
import { voiceUpgradeUnits } from './public/voice-dialog';

describe('настройка голоса (Э5)', () => {
  it('по умолчанию голос выключен (§4.10)', () => {
    expect(defaultVoiceConfig()).toEqual({
      schema: 1,
      input: false,
      output: false,
      voiceId: null,
    });
    expect(voiceConfigOf(null)).toEqual(defaultVoiceConfig());
    expect(voiceConfigOf({ input: 'да' })).toEqual(defaultVoiceConfig());
  });

  it('строгий разбор: типы, имя голоса, лишние ключи', () => {
    expect(
      parseVoiceConfig({ input: true, output: false, voiceId: 'Maya' }),
    ).toEqual({
      ok: true,
      config: { schema: 1, input: true, output: false, voiceId: 'Maya' },
    });
    const bad = parseVoiceConfig({
      input: 1,
      output: false,
      voiceId: 'x"; drop',
      autoplay: true,
    });
    expect(bad).toEqual({
      ok: false,
      errors: [
        { path: 'autoplay', code: 'unknown' },
        { path: 'input', code: 'type' },
        { path: 'voiceId', code: 'format' },
      ],
    });
    expect(parseVoiceConfig([]).ok).toBe(false);
  });

  it('формат записи: базовый тип без параметров; видео и мусор — нет', () => {
    expect(audioMimeOf('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(audioMimeOf('AUDIO/MP4')).toBe('audio/mp4');
    expect(audioMimeOf('video/webm')).toBeNull();
    expect(audioMimeOf(undefined)).toBeNull();
  });

  it('потолок голоса: ручной — как есть, иначе по тарифу; без тарифа — 0', () => {
    expect(voiceDailyCapMicroUsd(null, 'business')).toBe(1_500_000);
    expect(voiceDailyCapMicroUsd(null, 'pro')).toBe(4_000_000);
    expect(voiceDailyCapMicroUsd(null, 'start')).toBe(0);
    expect(voiceDailyCapMicroUsd(250, 'business')).toBe(250);
    expect(voiceDailyCapMicroUsd(250, null)).toBe(0);
  });

  it('вес голоса 2 и доплата в засчитанном диалоге (×2 после 30, ×3 после 60)', () => {
    expect(VOICE_DEFAULTS.dialogUnits).toBe(2);
    expect(voiceUpgradeUnits(1)).toBe(1);
    expect(voiceUpgradeUnits(30)).toBe(1);
    expect(voiceUpgradeUnits(31)).toBe(2);
    expect(voiceUpgradeUnits(61)).toBe(3);
    expect(voiceUpgradeUnits(0)).toBe(0);
  });

  it('тип записи — по байтам, не по заголовку: звук узнаётся, не звук — null', () => {
    const pad = (head: number[] | string, at = 0) => {
      const b = Buffer.alloc(64, 0x20);
      if (typeof head === 'string') b.write(head, at, 'latin1');
      else b.set(head, at);
      return b;
    };
    expect(sniffAudio(pad([0x1a, 0x45, 0xdf, 0xa3]))).toBe('audio/webm');
    expect(sniffAudio(pad('OggS'))).toBe('audio/ogg');
    // iOS Safari: MediaRecorder пишет mp4 (AAC) — `ftyp` с 4-го байта.
    expect(sniffAudio(pad('ftypM4A ', 4))).toBe('audio/mp4');
    const wav = pad('RIFF');
    wav.write('WAVE', 8, 'latin1');
    expect(sniffAudio(wav)).toBe('audio/wav');
    expect(sniffAudio(pad([0xff, 0xf1]))).toBe('audio/aac');
    expect(sniffAudio(pad('ID3'))).toBe('audio/mpeg');
    expect(sniffAudio(pad([0xff, 0xfb]))).toBe('audio/mpeg');
    // Не звук под `Content-Type: audio/webm` — HTML, JSON, PNG, нули.
    expect(sniffAudio(pad('<!doctype html>'))).toBeNull();
    expect(sniffAudio(pad('{"audio":"x"}'))).toBeNull();
    expect(
      sniffAudio(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBeNull();
    expect(sniffAudio(Buffer.alloc(4096))).toBeNull();
    expect(sniffAudio(Buffer.from([0x1a, 0x45, 0xdf]))).toBeNull();
  });
});
