import * as fs from 'fs';
import * as path from 'path';
import * as brand from './brand';
import {
  DEV_USER_HEADER,
  TELEGRAM_APP_HEADER,
  TELEGRAM_INIT_DATA_HEADER,
  VERIFY_FILE_PATH,
  WEB_SESSION_COOKIE,
  parseTelegramApp,
  verifyMetaTag,
  verifyTxtName,
  verifyTxtValue,
} from './brand';

describe('brand — публичные имена подтверждения владения (QA-ТЗ §2.4)', () => {
  it('TXT: имя `_v4c-verify.<хост>`, значение `v4c-verify=<токен>`', () => {
    expect(verifyTxtName('shop.example.com')).toBe(
      '_v4c-verify.shop.example.com',
    );
    expect(verifyTxtValue('abc123')).toBe('v4c-verify=abc123');
  });

  it('файл и мета — ровно как в ТЗ', () => {
    expect(VERIFY_FILE_PATH).toBe('/.well-known/v4c-verify.txt');
    expect(verifyMetaTag('abc123')).toBe(
      '<meta name="v4c-verify" content="abc123">',
    );
  });

  it('заголовок приложения — X-Telegram-App', () => {
    expect(TELEGRAM_APP_HEADER).toBe('X-Telegram-App');
  });

  it('cookie веб-кабинета — v4c_site_session', () => {
    expect(WEB_SESSION_COOKIE).toBe('v4c_site_session');
  });

  it('заголовки initData и дев-входа — как в зеркале фронта (site-tma-kit/src/brand.ts)', () => {
    expect(TELEGRAM_INIT_DATA_HEADER).toBe('X-Telegram-Init-Data');
    expect(DEV_USER_HEADER).toBe('X-Dev-User-Id');
  });
});

describe('parseTelegramApp — выбор бота без перебора токенов', () => {
  it('узнаёт оба приложения без учёта регистра и пробелов', () => {
    expect(parseTelegramApp('assist')).toBe('assist');
    expect(parseTelegramApp(' QA ')).toBe('qa');
  });

  it('всё прочее — null, а не «бот по умолчанию»', () => {
    expect(parseTelegramApp(undefined)).toBeNull();
    expect(parseTelegramApp('')).toBeNull();
    expect(parseTelegramApp('admin')).toBeNull();
    expect(parseTelegramApp(['assist', 'qa'])).toBeNull();
  });
});

describe('brand Э2 — публичные имена виджета только здесь (В-1)', () => {
  it('cookie указателя — __Host- (без Domain, Path=/, Secure)', () => {
    expect(brand.WIDGET_RESUME_COOKIE.startsWith('__Host-')).toBe(true);
  });

  it('домены — заглушки .invalid, пока бренд не решён', () => {
    expect(new URL(brand.WIDGET_ORIGIN_DEFAULT).hostname).toMatch(/\.invalid$/);
    expect(new URL(brand.WIDGET_POWERED_BY_URL).hostname).toMatch(/\.invalid$/);
  });

  it('ни один файл src (кроме brand.ts) не пишет имена виджета литералом', () => {
    const NAMES = [
      brand.WIDGET_GLOBAL,
      brand.WIDGET_PREVIEW_PARAM,
      brand.WIDGET_RESUME_COOKIE,
      brand.WIDGET_PK_LIVE_PREFIX,
      brand.WIDGET_PK_TEST_PREFIX,
      brand.WIDGET_MESSAGE_NS,
      'w.v4c.example.invalid',
    ];
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.ts$/.test(e.name) && !/brand(\.spec)?\.ts$/.test(e.name)) {
          const code = fs
            .readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1');
          for (const n of NAMES) {
            if (code.includes(n)) hits.push(`${full}: «${n}»`);
          }
        }
      }
    };
    walk(__dirname);
    expect(hits).toEqual([]);
  });
});
