/**
 * Выключатель сохранения фона — разбор значения и умолчание.
 *
 * Умолчание здесь не мелочь: от него зависит, начнёт ли прод платить
 * за разделение в момент деплоя или в момент, когда человек это
 * осознанно включит.
 */
import {
  AudioSeparationSettingsService,
  resolveSeparationState,
} from './audio-separation-settings';

describe('resolveSeparationState', () => {
  it('ничего не задано — ВЫКЛЮЧЕНО', () => {
    // Схема входа модели из среды разработки не проверялась; включиться
    // самим по факту появления ключа значило бы начать платить за
    // каждый дубляж всех пользователей ещё до первого удачного прогона.
    expect(resolveSeparationState(null)).toBe('off');
    expect(resolveSeparationState(undefined)).toBe('off');
    expect(resolveSeparationState('')).toBe('off');
  });

  it('включается только точным «on»', () => {
    expect(resolveSeparationState('on')).toBe('on');
    // Ничто похожее не считается включением: мусор в таблице настроек
    // не должен открывать платный путь.
    for (const junk of ['ON', 'true', '1', 'yes', 'включено', 'off ']) {
      expect(resolveSeparationState(junk)).toBe('off');
    }
  });
});

describe('AudioSeparationSettingsService', () => {
  function build(stored: string | null) {
    const settings = {
      get: jest.fn().mockResolvedValue(stored),
      set: jest.fn().mockResolvedValue(undefined),
    };
    return {
      svc: new AudioSeparationSettingsService(settings as never),
      settings,
    };
  }

  it('читает состояние по своему ключу', async () => {
    const { svc, settings } = build('on');

    expect(await svc.enabled()).toBe(true);
    expect(settings.get).toHaveBeenCalledWith('postprod.keepBackground');
  });

  it('пусто в базе — выключено', async () => {
    const { svc } = build(null);
    expect(await svc.enabled()).toBe(false);
  });

  it('запись сохраняет и значение, и автора', async () => {
    const { svc, settings } = build(null);

    await svc.set('on', 'op-1');

    expect(settings.set).toHaveBeenCalledWith(
      'postprod.keepBackground',
      'on',
      'op-1',
    );
  });
});
