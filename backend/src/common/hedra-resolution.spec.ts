import { hedraResolution } from './hedra-resolution';

describe('hedraResolution', () => {
  it('480p поднимается до 540p — меньшего у Hedra нет', () => {
    expect(hedraResolution('480p')).toBe('540p');
  });

  it('720p и 1080p совпадают и не трогаются', () => {
    expect(hedraResolution('720p')).toBe('720p');
    expect(hedraResolution('1080p')).toBe('1080p');
  });

  it('экономное разрешение не становится дорогим', () => {
    // Округление к ВЕРХНЕМУ доступному (720p) означало бы, что выбор
    // «подешевле» молча стоит как «получше»: у Hedra 540p и 720p
    // тарифицируются по-разному.
    expect(hedraResolution('480p')).not.toBe('720p');
  });
});
