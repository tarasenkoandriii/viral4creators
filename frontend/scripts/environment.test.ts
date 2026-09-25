import assert from 'node:assert/strict';
import {
  describeEnvironment,
  envKey,
  type RawEnvironment,
} from '../src/lib/environment';

const raw = (over: Partial<RawEnvironment> = {}): RawEnvironment => ({
  hasTelegram: true,
  tgPlatform: 'ios',
  tgVersion: '7.10',
  tgColorScheme: 'dark',
  tgLanguage: 'ru',
  ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15',
  maxTouchPoints: 5,
  browserLanguage: 'ru-RU',
  uiLocale: 'uk',
  theme: 'dark',
  screen: { w: 390, h: 844, dpr: 3 },
  viewport: { w: 390, h: 760 },
  network: '4g',
  appBuild: '2026.09.25-a1b2c3d',
  ...over,
});

const UA = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15',
  android:
    'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 Chrome/120',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
};

// ── Поверхность ──────────────────────────────────────────────────────
// Внутри Telegram мы, только если оттуда пришли ДАННЫЕ: сам объект
// window.Telegram бывает и в обычном браузере, если подключён SDK.
assert.equal(describeEnvironment(raw()).surface, 'TMA');
assert.equal(
  describeEnvironment(raw({ hasTelegram: false })).surface,
  'BROWSER'
);

// ── Семейство и версия ОС ────────────────────────────────────────────
// `maxTouchPoints` здесь — ноль по умолчанию: настольные строки должны
// читаться как настольные, а случай «маковская строка + касания» (iPad
// в браузере) проверяется отдельно ниже.
const os = (
  ua: string,
  tgPlatform: string | null = null,
  maxTouchPoints = 0
) => {
  const e = describeEnvironment(raw({ ua, tgPlatform, maxTouchPoints }));
  return `${e.osFamily}/${e.osVersion ?? '—'}`;
};
assert.equal(os(UA.iphone), 'ios/18.1');
assert.equal(os(UA.ipad), 'ios/17.5');
assert.equal(os(UA.android), 'android/14');
assert.equal(os(UA.mac), 'macos/10.15');
assert.equal(os(UA.win), 'windows/10.0');
assert.equal(os(UA.linux), 'linux/—');
assert.equal(os(''), 'unknown/—');
// Платформа Telegram спасает, когда строки нет: в родном клиенте она
// приходит от самого приложения.
assert.equal(os('', 'ios'), 'ios/—');
assert.equal(os('', 'android'), 'android/—');

// ── Вид устройства ───────────────────────────────────────────────────
const kind = (
  ua: string,
  tgPlatform: string | null = null,
  viewport: { w: number; h: number } | null = { w: 390, h: 760 },
  maxTouchPoints = 0
) =>
  describeEnvironment(raw({ ua, tgPlatform, viewport, maxTouchPoints }))
    .deviceKind;

assert.equal(kind(UA.iphone, 'ios'), 'PHONE');
assert.equal(kind(UA.android, 'android'), 'PHONE');
assert.equal(kind(UA.mac, 'macos'), 'DESKTOP');
assert.equal(kind(UA.win, 'tdesktop'), 'DESKTOP');
// iPad раньше всего: с iPadOS 13+ он представляется как Mac, и по
// платформе его было бы не отличить от настольного.
assert.equal(kind(UA.ipad, 'ios'), 'TABLET');
assert.equal(kind(UA.ipad, null), 'TABLET');
// Telegram Web бывает где угодно — считать его настольным по имени
// значило бы ошибаться ровно там, где чаще всего ломается вёрстка.
assert.equal(kind(UA.iphone, 'weba'), 'PHONE');
assert.equal(kind(UA.android, 'webk'), 'PHONE');
assert.equal(kind(UA.mac, 'weba'), 'DESKTOP');
// Строки нет вовсе — последняя опора ширина окна.
assert.equal(kind('', null, { w: 390, h: 760 }), 'PHONE');
assert.equal(kind('', null, { w: 1440, h: 900 }), 'DESKTOP');
assert.equal(kind('', null, null), 'DESKTOP');

// ── Локаль: четыре разных значения не смешиваются ───────────────────
const e = describeEnvironment(raw());
assert.equal(e.uiLocale, 'uk');
assert.equal(e.tgLanguage, 'ru');
assert.equal(e.browserLanguage, 'ru-RU');
// Расхождение интерфейса и клиента Telegram — само по себе признак:
// человек переключал язык руками, и половина «перевод не подхватился»
// случается именно на этом.
assert.notEqual(e.uiLocale, e.tgLanguage);

// Сырой `ua` сохраняется рядом с выведенным — нормализация ошибётся, и
// переразбирать придётся по нему.
assert.equal(e.ua, UA.iphone);
assert.equal(describeEnvironment(raw({ ua: '   ' })).ua, null);

// ── Ключ группировки ────────────────────────────────────────────────
assert.equal(
  envKey({
    scenario: 'PRODUCT_VIDEO',
    stepId: 'prompt',
    surface: 'TMA',
    tgPlatform: 'ios',
    osFamily: 'ios',
    uiLocale: 'uk',
  }),
  'product_video:prompt:tma:ios:uk'
);
// Без платформы Telegram — семейство ОС: в браузере платформы нет, а
// группировать всё равно надо.
assert.equal(
  envKey({
    scenario: 'PRODUCT_VIDEO',
    stepId: null,
    surface: 'BROWSER',
    tgPlatform: null,
    osFamily: 'windows',
    uiLocale: 'de',
  }),
  'product_video:-:browser:windows:de'
);
// Пустые части не схлопываются: ключ из четырёх двоеточий читается и
// сравнивается, ключ из трёх — уже другой ключ.
assert.equal(
  envKey({
    scenario: null,
    stepId: null,
    surface: 'TMA',
    tgPlatform: null,
    osFamily: 'unknown',
    uiLocale: '',
  }),
  '-:-:tma:unknown:-'
);
// Локаль — часть условия: у «поехала вёрстка» язык значит столько же,
// сколько платформа.
const sameButLocale = (locale: string) =>
  envKey({
    scenario: 'PRODUCT_VIDEO',
    stepId: 'prompt',
    surface: 'TMA',
    tgPlatform: 'ios',
    osFamily: 'ios',
    uiLocale: locale,
  });
assert.notEqual(sameButLocale('ru'), sameButLocale('de'));

// ── iPad в браузере: строка совпадает с маковской (аудит 156) ────────
//
// Родной клиент Telegram отдаёт честный токен `iPad`, а Safari и
// Telegram Web на iPadOS 13+ — маковскую строку. До аудита проверялся
// только токен, и второй случай ехал в тикет как настольный Mac.
assert.equal(
  describeEnvironment(raw({ ua: UA.ipad, tgPlatform: 'ios' })).deviceKind,
  'TABLET'
);
assert.equal(
  describeEnvironment(
    raw({ ua: UA.mac, tgPlatform: null, maxTouchPoints: 5, hasTelegram: false })
  ).deviceKind,
  'TABLET'
);
assert.equal(
  describeEnvironment(
    raw({ ua: UA.mac, tgPlatform: null, maxTouchPoints: 5, hasTelegram: false })
  ).osFamily,
  'ios'
);
// Настоящий Mac касаний не держит — он обязан остаться настольным.
assert.equal(
  describeEnvironment(
    raw({ ua: UA.mac, tgPlatform: null, maxTouchPoints: 0, hasTelegram: false })
  ).deviceKind,
  'DESKTOP'
);
assert.equal(
  describeEnvironment(
    raw({ ua: UA.mac, tgPlatform: null, maxTouchPoints: 0, hasTelegram: false })
  ).osFamily,
  'macos'
);
// Поле отсутствует вовсе (старый браузер) — ведём себя как Mac, а не
// как iPad: догадка в сторону «устройство обычное» безопаснее.
assert.equal(
  describeEnvironment(
    raw({
      ua: UA.mac,
      tgPlatform: null,
      maxTouchPoints: null,
      hasTelegram: false,
    })
  ).deviceKind,
  'DESKTOP'
);
// Версию iPadOS из маковской строки не выдумываем: `10_15_7` — это
// версия Mac OS X, к iPadOS отношения не имеющая.
assert.equal(
  describeEnvironment(
    raw({ ua: UA.mac, tgPlatform: null, maxTouchPoints: 5, hasTelegram: false })
  ).osVersion,
  null
);
// А из честной строки iPad — берём.
assert.equal(
  describeEnvironment(raw({ ua: UA.ipad, tgPlatform: 'ios' })).osVersion,
  '17.5'
);

// ── Тема доезжает как есть (аудит 156) ──────────────────────────────
//
// Нормализация её не трогает: это уже ответ `applyTheme()`, то есть то,
// что человек видел, а не то, что стоит в Telegram.
assert.equal(
  describeEnvironment(raw({ theme: 'light', tgColorScheme: 'dark' })).theme,
  'light'
);
assert.equal(
  describeEnvironment(raw({ theme: 'light', tgColorScheme: 'dark' }))
    .tgColorScheme,
  'dark'
);

console.log('environment: ok');
