import { pickVeoModel, usesVeo30 } from './veo-model-choice';

// Найдено при аудите: реальный сбой в проде (2026-09-13) подтвердил
// предупреждение, уже стоявшее в доккомментарии файла — первая догадка
// об ID модели Veo 3.0 (`veo-3.0-generate-001`) оказалась 404 у Gemini
// API. Функция теперь ОТКЛЮЧЕНА (`VEO_3_0_ENABLED = false` внутри
// файла) — тесты ниже проверяют именно это, а не старое поведение
// переключения, которое сейчас не выполняется никогда.
describe('pickVeoModel — отключено после сбоя в проде (см. доккомментарий файла)', () => {
  it('нет персонажей + standard — раньше переключало на Veo 3.0, сейчас фолбэк', () => {
    expect(
      pickVeoModel({ legacyFirstFrame: true }, 'standard', 'veo-3.1-generate-preview'),
    ).toBe('veo-3.1-generate-preview');
  });

  it('есть персонажи + standard — фолбэк, как и было', () => {
    expect(
      pickVeoModel({ legacyFirstFrame: false }, 'standard', 'veo-3.1-generate-preview'),
    ).toBe('veo-3.1-generate-preview');
  });

  it('fast — всегда фолбэк, независимо от персонажей', () => {
    expect(
      pickVeoModel({ legacyFirstFrame: true }, 'fast', 'veo-3.1-lite-generate-preview'),
    ).toBe('veo-3.1-lite-generate-preview');
    expect(
      pickVeoModel({ legacyFirstFrame: false }, 'fast', 'veo-3.1-lite-generate-preview'),
    ).toBe('veo-3.1-lite-generate-preview');
  });
});

describe('usesVeo30 — отключено после сбоя в проде', () => {
  it('всегда false, пока VEO_3_0_ENABLED = false — даже в комбинации, для которой это раньше было true', () => {
    expect(usesVeo30({ legacyFirstFrame: true }, 'standard')).toBe(false);
  });

  it('false для fast, даже без персонажей', () => {
    expect(usesVeo30({ legacyFirstFrame: true }, 'fast')).toBe(false);
  });

  it('false с персонажами, даже на standard', () => {
    expect(usesVeo30({ legacyFirstFrame: false }, 'standard')).toBe(false);
  });
});
