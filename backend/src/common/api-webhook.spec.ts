import {
  isDeliverableUrl,
  isDelivered,
  isRetryable,
  signWebhook,
} from './api-webhook';

/**
 * Этап 146. Подпись доставки и проверка адреса.
 */
describe('signWebhook', () => {
  it('подпись зависит и от времени, и от тела', () => {
    const a = signWebhook('secret', '1000', '{"a":1}');
    expect(signWebhook('secret', '1001', '{"a":1}')).not.toBe(a);
    expect(signWebhook('secret', '1000', '{"a":2}')).not.toBe(a);
    expect(signWebhook('other', '1000', '{"a":1}')).not.toBe(a);
  });

  it('точка между временем и телом не даёт их подменить друг другом', () => {
    // Без разделителя время «1» + тело «23» и время «12» + тело «3»
    // дали бы одну подпись, и одно можно было бы выдать за другое.
    expect(signWebhook('s', '1', '23')).not.toBe(signWebhook('s', '12', '3'));
  });

  it('формат подписи называет алгоритм', () => {
    // Чужая сторона должна знать, чем проверять, не читая нашу
    // документацию второй раз.
    expect(signWebhook('s', '1', '{}')).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe('isDeliverableUrl', () => {
  it('обычный https-адрес годится', () => {
    expect(isDeliverableUrl('https://hooks.example.com/v4c')).toBe(true);
  });

  it('http не годится: подпись и тело уехали бы открытым текстом', () => {
    expect(isDeliverableUrl('http://hooks.example.com/v4c')).toBe(false);
  });

  it('свои и служебные адреса закрыты', () => {
    // По адресу ходит НАШ сервер изнутри нашей же сети — это способ
    // достучаться туда, куда снаружи не достучаться.
    for (const url of [
      'https://localhost/hook',
      'https://127.0.0.1/hook',
      'https://10.1.2.3/hook',
      'https://172.16.0.1/hook',
      'https://192.168.1.1/hook',
      'https://169.254.169.254/latest/meta-data/',
      'https://metadata.google.internal/x',
      'https://[::1]/hook',
      'https://api.internal/hook',
      'https://printer.local/hook',
      'https://intranet/hook',
    ]) {
      expect([url, isDeliverableUrl(url)]).toEqual([url, false]);
    }
  });

  it('публичные адреса из тех же диапазонов-соседей проходят', () => {
    // 172.32 — уже не частный, и запрещать его было бы перебором.
    expect(isDeliverableUrl('https://172.32.0.1/hook')).toBe(true);
    expect(isDeliverableUrl('https://11.0.0.1/hook')).toBe(true);
  });

  it('логин с паролем в адресе — чужой секрет в нашей базе', () => {
    expect(isDeliverableUrl('https://user:pass@hooks.example.com/x')).toBe(
      false,
    );
  });

  it('мусор вместо адреса — не адрес', () => {
    expect(isDeliverableUrl('вебхук')).toBe(false);
    expect(isDeliverableUrl('')).toBe(false);
  });
});

describe('isDelivered / isRetryable', () => {
  it('доставкой считается только 2xx', () => {
    expect(isDelivered(200)).toBe(true);
    expect(isDelivered(204)).toBe(true);
    // 3xx — это «не здесь», а не «получил».
    expect(isDelivered(302)).toBe(false);
    expect(isDelivered(404)).toBe(false);
  });

  it('повторяем то, что может пройти позже', () => {
    expect(isRetryable(500)).toBe(true);
    expect(isRetryable(503)).toBe(true);
    expect(isRetryable(null)).toBe(true);
    expect(isRetryable(408)).toBe(true);
    expect(isRetryable(429)).toBe(true);
  });

  it('«ты прислал не то» повтором не лечится', () => {
    // Повтор пришлёт ровно то же самое.
    expect(isRetryable(400)).toBe(false);
    expect(isRetryable(401)).toBe(false);
    expect(isRetryable(404)).toBe(false);
  });
});
