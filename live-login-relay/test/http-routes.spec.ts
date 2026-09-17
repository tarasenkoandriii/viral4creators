import { parseCreateSessionBody } from '../src/http-routes';

/**
 * Регрессия аудита этапа 108: у `http-routes.ts` не было ни одного
 * теста, притом что именно здесь живёт единственная проверка входных
 * `startUrl`/`allowedOrigin` на стороне реле (§7 спеки).
 *
 * Ключевая находка — сверки origin'ов друг с другом недостаточно: у
 * `file:`/`data:`/`javascript:` origin равен строке "null", поэтому ЛЮБАЯ
 * пара таких URL проходила проверку «origin совпал», и реле открывало бы
 * локальный файл контейнера, транслируя его человеку по WS.
 */
describe('parseCreateSessionBody', () => {
  it('принимает корректную пару https', () => {
    expect(
      parseCreateSessionBody({
        startUrl: 'https://shop.example.com/login?next=/cabinet',
        allowedOrigin: 'https://shop.example.com',
      }),
    ).toEqual({
      ok: true,
      startUrl: 'https://shop.example.com/login?next=/cabinet',
      allowedOrigin: 'https://shop.example.com',
    });
  });

  it('принимает http (локальный стенд заказчика без TLS — не наше дело)', () => {
    expect(
      parseCreateSessionBody({
        startUrl: 'http://localhost:3000/login',
        allowedOrigin: 'http://localhost:3000',
      }),
    ).toMatchObject({ ok: true });
  });

  it('отклоняет file:// (origin обоих — "null", раньше проходило)', () => {
    const result = parseCreateSessionBody({
      startUrl: 'file:///etc/passwd',
      allowedOrigin: 'file:///etc/passwd',
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('http(s)');
  });

  it('отклоняет две РАЗНЫЕ file://-ссылки (та же дыра, другой вход)', () => {
    expect(
      parseCreateSessionBody({
        startUrl: 'file:///root/.ssh/id_rsa',
        allowedOrigin: 'file:///etc/hosts',
      }).ok,
    ).toBe(false);
  });

  it('отклоняет data: и javascript:', () => {
    for (const scheme of [
      'data:text/html,<h1>hi</h1>',
      'javascript:alert(1)',
    ]) {
      expect(
        parseCreateSessionBody({ startUrl: scheme, allowedOrigin: scheme }).ok,
      ).toBe(false);
    }
  });

  it('отклоняет несовпадающие origin', () => {
    const result = parseCreateSessionBody({
      startUrl: 'https://evil.example.net/login',
      allowedOrigin: 'https://shop.example.com',
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain('origin');
  });

  it('отклоняет не-объект, отсутствующие и нестроковые поля', () => {
    expect(parseCreateSessionBody(null).ok).toBe(false);
    expect(parseCreateSessionBody('строка').ok).toBe(false);
    expect(parseCreateSessionBody({}).ok).toBe(false);
    expect(
      parseCreateSessionBody({
        startUrl: 42,
        allowedOrigin: 'https://a.example',
      }).ok,
    ).toBe(false);
  });

  it('отклоняет невалидные URL', () => {
    expect(
      parseCreateSessionBody({
        startUrl: 'не url',
        allowedOrigin: 'тоже не url',
      }).ok,
    ).toBe(false);
  });

  it('нормализует allowedOrigin до origin (путь/строка запроса отбрасываются)', () => {
    const result = parseCreateSessionBody({
      startUrl: 'https://shop.example.com/login',
      allowedOrigin: 'https://shop.example.com/cabinet?a=1',
    });
    expect(result).toMatchObject({
      ok: true,
      allowedOrigin: 'https://shop.example.com',
    });
  });
});
