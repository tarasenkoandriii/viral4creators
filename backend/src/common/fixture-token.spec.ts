import { fixtureTelegramIdFromHeader } from './fixture-token';

const ENV = { FIXTURE_USER_TOKEN: 'sekret', FIXTURE_TELEGRAM_ID: 'fixture-1' };

describe('fixtureTelegramIdFromHeader', () => {
  it('верный токен возвращает настроенный telegramId', () => {
    expect(fixtureTelegramIdFromHeader('sekret', ENV)).toBe('fixture-1');
  });

  it('неверный токен — null', () => {
    expect(fixtureTelegramIdFromHeader('другое', ENV)).toBeNull();
  });

  it('токен другой длины — null (не роняет сравнение)', () => {
    expect(fixtureTelegramIdFromHeader('se', ENV)).toBeNull();
  });

  it('заголовок не пришёл — null', () => {
    expect(fixtureTelegramIdFromHeader(undefined, ENV)).toBeNull();
  });

  it('FIXTURE_USER_TOKEN не задан — fail-closed, null даже с правильным на вид значением', () => {
    expect(
      fixtureTelegramIdFromHeader('sekret', {
        FIXTURE_TELEGRAM_ID: 'fixture-1',
      }),
    ).toBeNull();
  });

  it('FIXTURE_TELEGRAM_ID не задан — fail-closed, null', () => {
    expect(
      fixtureTelegramIdFromHeader('sekret', { FIXTURE_USER_TOKEN: 'sekret' }),
    ).toBeNull();
  });

  it('лишние пробелы вокруг значений не мешают совпадению', () => {
    expect(fixtureTelegramIdFromHeader('  sekret  ', ENV)).toBe('fixture-1');
  });
});
