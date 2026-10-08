import { BadRequestException } from '@nestjs/common';
import { AdminSpeechRecognitionSettingsService } from './admin-speech-recognition-settings.service';

function build(stored: string | null) {
  const settings = {
    get: jest.fn().mockResolvedValue(stored),
    set: jest.fn().mockResolvedValue(undefined),
  };
  return {
    svc: new AdminSpeechRecognitionSettingsService(settings as never),
    settings,
  };
}

describe('AdminSpeechRecognitionSettingsService', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('не менялось — Soniox (Р-З8-14, замер §8.3), источник «default»', async () => {
    const { svc } = build(null);
    expect(await svc.get()).toMatchObject({
      active: 'soniox',
      source: 'default',
    });
  });

  it('неизвестное сохранённое значение — тоже умолчание Soniox', async () => {
    const { svc } = build('whisper');
    expect(await svc.get()).toMatchObject({
      active: 'soniox',
      source: 'default',
    });
  });

  it('Gemini, выбранный в админке, главнее умолчания', async () => {
    const { svc } = build('gemini');
    expect(await svc.get()).toMatchObject({
      active: 'gemini',
      source: 'admin',
    });
  });

  it('выбран Soniox — видно, настроен ли ключ на стенде', async () => {
    delete process.env.SONIOX_API_KEY;
    const { svc } = build('soniox');
    const view = await svc.get();
    expect(view).toMatchObject({ active: 'soniox', source: 'admin' });
    expect(view.options.find((o) => o.key === 'soniox')?.configured).toBe(
      false,
    );
    process.env.SONIOX_API_KEY = 'sk';
    expect(
      (await svc.get()).options.find((o) => o.key === 'soniox')?.configured,
    ).toBe(true);
  });

  it('неизвестный провайдер — отказ, ничего не пишется', async () => {
    const { svc, settings } = build(null);
    await expect(svc.set('whisper', 'op')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('выбор пишется с оператором', async () => {
    const { svc, settings } = build('soniox');
    await svc.set('soniox', 'op-1');
    expect(settings.set).toHaveBeenCalledWith(
      'speech_recognition_provider',
      'soniox',
      'op-1',
    );
  });
});
