/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые двойники */
/**
 * S2: голос Soniox отправителя — общее правило режима звука и маршрут
 * выбора (контроллер + DTO).
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  SONIOX_VOICE_ID_PATTERN,
  greetingVoiceMode,
  sonioxVoiceChosen,
  sonioxVoiceProblem,
  sonioxVoiceSounds,
} from './greeting-soniox-voice';
import { GreetingVoiceController } from '../modules/greeting-voice/greeting-voice.controller';
import { GreetingSenderVoiceRequestDto } from '../modules/greeting-voice/dto/greeting-voice.dto';

jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));

const SONIOX = { sonioxVoice: { voiceId: 'Maya', label: 'Maya' } };
const DEFAULT = { sonioxVoice: { voiceId: null, label: null } };

describe('greetingVoiceMode', () => {
  it('Soniox выбран — режим veo бренда становится voiceover', () => {
    expect(greetingVoiceMode(SONIOX, 'veo')).toBe('voiceover');
    expect(greetingVoiceMode(DEFAULT, 'veo')).toBe('voiceover');
  });

  it('режимы со своим голосом не трогаются (dub остаётся dub)', () => {
    expect(greetingVoiceMode(SONIOX, 'dub')).toBe('dub');
    expect(greetingVoiceMode(SONIOX, 'voiceover')).toBe('voiceover');
  });

  it('без Soniox — режим бренда как есть', () => {
    for (const brief of [null, undefined, {}, { sonioxVoice: null }]) {
      expect(greetingVoiceMode(brief, 'veo')).toBe('veo');
      expect(greetingVoiceMode(brief, 'dub')).toBe('dub');
    }
  });

  it('sonioxVoiceChosen — голос по умолчанию тоже выбор', () => {
    expect(sonioxVoiceChosen(DEFAULT)).toBe(true);
    expect(sonioxVoiceChosen({ sonioxVoice: null })).toBe(false);
    expect(sonioxVoiceChosen(null)).toBe(false);
  });

  it('форма id: имена каталога проходят, разметка и пути — нет', () => {
    for (const ok of ['Maya', 'Adrian', 'en-US_1', 'voice.2']) {
      expect(SONIOX_VOICE_ID_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of ['', ' Maya', '<AUDIO_0>', '../x', 'й', 'a'.repeat(65)]) {
      expect(SONIOX_VOICE_ID_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe('PATCH /sessions/:id/greeting-voice — маршрут голоса Soniox', () => {
  const service = () => ({
    select: jest.fn().mockResolvedValue('clone'),
    selectPreset: jest.fn().mockResolvedValue('preset'),
    selectSoniox: jest.fn().mockResolvedValue('soniox'),
  });

  it('sonioxVoice читается первым; null — снятие', async () => {
    const svc = service();
    const ctl = new GreetingVoiceController(svc as any);
    await expect(
      ctl.select('s1', { sonioxVoice: { voiceId: 'Maya' } } as any),
    ).resolves.toBe('soniox');
    expect(svc.selectSoniox).toHaveBeenCalledWith('s1', { voiceId: 'Maya' });
    await ctl.select('s1', { sonioxVoice: null, presetVoiceId: 'eve' } as any);
    expect(svc.selectSoniox).toHaveBeenLastCalledWith('s1', null);
    expect(svc.selectPreset).not.toHaveBeenCalled();
    expect(svc.select).not.toHaveBeenCalled();
  });

  it('без sonioxVoice — прежние ветки', async () => {
    const svc = service();
    const ctl = new GreetingVoiceController(svc as any);
    await expect(ctl.select('s1', { presetVoiceId: 'eve' })).resolves.toBe(
      'preset',
    );
    await expect(ctl.select('s1', { resembleVoiceId: 'rv' })).resolves.toBe(
      'clone',
    );
    expect(svc.selectSoniox).not.toHaveBeenCalled();
  });

  const errorsOf = (body: unknown) =>
    validateSync(plainToInstance(GreetingSenderVoiceRequestDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it('DTO: объект с voiceId строкой/null и null целиком — валидны', () => {
    for (const body of [
      { sonioxVoice: { voiceId: 'Maya' } },
      { sonioxVoice: { voiceId: null } },
      { sonioxVoice: {} },
      { sonioxVoice: null },
    ]) {
      expect(errorsOf(body)).toHaveLength(0);
    }
  });

  it('DTO: строка вместо объекта, число и длинный id — отказ', () => {
    for (const body of [
      { sonioxVoice: 'Maya' },
      { sonioxVoice: { voiceId: 42 } },
      { sonioxVoice: { voiceId: 'a'.repeat(65) } },
      { sonioxVoice: { voiceId: 'Maya', extra: 1 } },
    ]) {
      expect(errorsOf(body).length).toBeGreaterThan(0);
    }
  });
});

describe('sonioxVoiceProblem / sonioxVoiceSounds — проверка у денег (аудит S2)', () => {
  const tts = (over: { configured?: boolean; voices?: jest.Mock } = {}) => ({
    configured: () => over.configured ?? true,
    voices:
      over.voices ??
      jest.fn().mockResolvedValue({ voices: [{ voiceId: 'Maya' }] }),
  });
  const code = async (p: Promise<{ code: string } | null>) =>
    (await p)?.code ?? null;

  it('нет ключа — недоступно даже для голоса по умолчанию', async () => {
    for (const id of ['Maya', null]) {
      await expect(
        code(sonioxVoiceProblem(tts({ configured: false }), id)),
      ).resolves.toBe('GREETING_SONIOX_UNAVAILABLE');
    }
  });

  it('голос по умолчанию каталог не читает; голос каталога — да', async () => {
    const t = tts();
    await expect(sonioxVoiceProblem(t, null)).resolves.toBeNull();
    await expect(sonioxVoiceProblem(t, '  ')).resolves.toBeNull();
    expect(t.voices).not.toHaveBeenCalled();
    await expect(sonioxVoiceProblem(t, ' Maya ')).resolves.toBeNull();
    await expect(code(sonioxVoiceProblem(t, 'Zed'))).resolves.toBe(
      'GREETING_SONIOX_VOICE_UNKNOWN',
    );
    await expect(code(sonioxVoiceProblem(t, '<x>'))).resolves.toBe(
      'GREETING_SONIOX_VOICE_UNKNOWN',
    );
  });

  it('строка не похожа на id — отказ даже при непрочитанном каталоге', async () => {
    const voices = jest.fn().mockResolvedValue({ voices: [], error: '503' });
    await expect(
      code(sonioxVoiceProblem(tts({ voices }), '<AUDIO_0>')),
    ).resolves.toBe('GREETING_SONIOX_VOICE_UNKNOWN');
    expect(voices).not.toHaveBeenCalled();
  });

  it('каталог не прочитан — пропускает', async () => {
    for (const voices of [
      jest.fn().mockResolvedValue({ voices: [], error: '503' }),
      jest.fn().mockRejectedValue(new Error('сеть')),
    ]) {
      await expect(
        sonioxVoiceProblem(tts({ voices }), 'Zed'),
      ).resolves.toBeNull();
    }
  });

  it('звучит ли Soniox: клон и пресет перебивают', () => {
    expect(sonioxVoiceSounds(SONIOX)).toBe(true);
    expect(sonioxVoiceSounds(DEFAULT)).toBe(true);
    expect(sonioxVoiceSounds({ ...SONIOX, presetVoiceId: 'eve' })).toBe(false);
    expect(sonioxVoiceSounds({ ...SONIOX, presetVoiceId: '  ' })).toBe(true);
    expect(
      sonioxVoiceSounds({
        ...SONIOX,
        senderVoice: { userVoiceId: 'u', resembleVoiceId: 'r', label: 'L' },
      }),
    ).toBe(false);
    expect(sonioxVoiceSounds({ sonioxVoice: null })).toBe(false);
    expect(sonioxVoiceSounds(null)).toBe(false);
  });
});
