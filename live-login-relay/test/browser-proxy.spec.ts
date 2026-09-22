/**
 * Прокси для подконтрольного браузера (§4, §6 спеки).
 *
 * Зачем вообще: Telegram не присылал подтверждение входа на сессию,
 * поднятую из датацентра. Гипотеза про IP на момент написания этих
 * тестов НЕ подтверждена — проверяется здесь не она, а механика:
 * разбор переменной, флаг Chromium и то, что учётные данные уходят
 * страницей, а не в командной строке.
 */

import { ConfigError, parseBrowserProxy } from '../src/config';
import { DOCKER_CHROMIUM_ARGS, proxyArgs } from '../src/launch-browser';

describe('parseBrowserProxy', () => {
  it('пустое значение — ходим напрямую', () => {
    expect(parseBrowserProxy(undefined)).toBeNull();
    expect(parseBrowserProxy('')).toBeNull();
    expect(parseBrowserProxy('   ')).toBeNull();
  });

  it('адрес без учётных данных', () => {
    expect(parseBrowserProxy('http://proxy.example.com:8080')).toEqual({
      server: 'http://proxy.example.com:8080',
    });
  });

  it('учётные данные вынимаются из URL и НЕ остаются в адресе', () => {
    // Ключевое: `server` уезжает в `--proxy-server`, то есть в
    // командную строку процесса. Пароля там быть не должно.
    expect(parseBrowserProxy('http://user:s3cret@p.example.com:80')).toEqual({
      server: 'http://p.example.com:80',
      username: 'user',
      password: 's3cret',
    });
  });

  it('спецсимволы в пароле разэкранируются', () => {
    const parsed = parseBrowserProxy('http://u:p%40ss%3A1@host:3128');
    expect(parsed?.password).toBe('p@ss:1');
  });

  it('socks5 принимается — Chromium его понимает', () => {
    expect(parseBrowserProxy('socks5://host:1080')?.server).toBe(
      'socks5://host:1080',
    );
  });

  it('дефолтный порт не теряется при разборе', () => {
    // `URL.host` выбрасывает :80 у http — адрес в логе и в `ps` иначе
    // не совпал бы с тем, что задано в переменной.
    expect(parseBrowserProxy('http://host:80')?.server).toBe('http://host:80');
    expect(parseBrowserProxy('https://host')?.server).toBe('https://host:443');
  });

  it('socks без явного порта отклоняется — дефолта у схемы нет', () => {
    expect(() => parseBrowserProxy('socks5://host')).toThrow(ConfigError);
  });

  it('кривое значение роняет старт, а не уходит напрямую молча', () => {
    // Тихий откат — худший вариант: прокси ставят, когда прямой выход
    // НЕ подходит, и «молча пошли напрямую» человек узнает от чужого
    // антифрода, а не из логов.
    expect(() => parseBrowserProxy('не-url')).toThrow(ConfigError);
    // Порт НЕдефолтный намеренно: с `ftp://host:21` проверка прошла бы
    // мимо схемы — `new URL` выбрасывает дефолтный порт, и падало бы
    // правило «порт укажите явно», а не правило схемы. Мутационный
    // прогон это и вскрыл: тест был зелёным при вырезанной проверке.
    expect(() => parseBrowserProxy('ftp://host:2121')).toThrow(ConfigError);
    expect(() => parseBrowserProxy('http://user@host:80')).toThrow(ConfigError);
  });
});

describe('proxyArgs', () => {
  it('без прокси аргументов не добавляется вовсе', () => {
    expect(proxyArgs(null)).toEqual([]);
  });

  it('с прокси — ровно один флаг', () => {
    expect(proxyArgs({ server: 'http://host:80' })).toEqual([
      '--proxy-server=http://host:80',
    ]);
  });

  it('пароль в аргументы не попадает', () => {
    const args = proxyArgs({
      server: 'http://host:80',
      username: 'user',
      password: 's3cret',
    });
    expect(args.join(' ')).not.toContain('s3cret');
    expect(args.join(' ')).not.toContain('user');
  });

  it('базовые аргументы Chromium не трогаются', () => {
    // Список скопирован построчно из backend'а; прокси не повод его
    // менять.
    expect(DOCKER_CHROMIUM_ARGS).toContain('--no-sandbox');
    expect(DOCKER_CHROMIUM_ARGS.join(' ')).not.toContain('--proxy-server');
  });
});
