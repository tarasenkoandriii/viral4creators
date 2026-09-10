/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { EnvCheckResult, EnvLike, getEnvSettings } from './env-settings';
import { randomBytes } from 'crypto';

/**
 * Вкладка «Настройки» отдаёт по каждой переменной вердикт, а по
 * некоторым — ещё и значение. Разделение «что секрет, а что нет» здесь
 * держится на одном поле `value`, которое автор проверки выставляет
 * руками, — и до этого файла ничто не мешало приписать `value: raw`
 * строке про `GOOGLE_API_KEY` или `DATABASE_URL`. Такая правка утекла бы
 * в ответ API и поймалась только чтением диффа.
 *
 * Отсюда два теста. Первый — прямой: секретные переменные заданы
 * уникальными строками-маркерами, и ни один маркер не должен встретиться
 * в ответе целиком. Второй — общий: маркерами задаются ВСЕ известные
 * переменные, и множество тех, чьё значение видно наружу, обязано
 * совпасть с явным списком ниже. Второй сильнее первого: он падает и
 * тогда, когда наружу утекает что-то, что сегодня секретом не считали,
 * — то есть заставляет решение «это можно показывать» приниматься
 * осознанно, а не появляться в диффе между делом.
 */

/** Уникальный маркер: подстрока, которая не может возникнуть сама. */
const marker = (key: string) => `__MARKER_${key}__`;

/**
 * Переменные, значения которых наружу выходить НЕ должны никогда:
 * строки подключения с паролями, ключи внешних API, токены ботов,
 * секрет крона.
 */
const SECRET_KEYS = [
  'DATABASE_URL',
  'DIRECT_URL',
  'BLOB_READ_WRITE_TOKEN',
  'BLOB_STORE_ID',
  'GEMINI_API_KEY',
  'GOOGLE_GEMINI_API_KEY',
  'LAOZHANG_API_KEY',
  'OPENAI_API_KEY',
  'SERPAPI_API_KEY',
  'YOUTUBE_API_KEY',
  'FFMPEG_API_KEY',
  'VOICE_API_KEY',
  // doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md — второй провайдер синтеза.
  'RESEMBLE_API_KEY',
  'CRON_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'ADMIN_LOGIN_BOT_TOKEN',
  // Этап 62 (ТЗ §41): секрет входящего вебхука Telegram, HMAC-секрет
  // WayForPay и ключ шифрования recToken — ни один не показывается.
  'TELEGRAM_WEBHOOK_SECRET',
  'WAYFORPAY_MERCHANT_SECRET',
  'PAYMENT_TOKEN_KEY',
  // Этап 73 (TODO п.32): секрет вебхука подтверждения клона голоса —
  // тот же класс, что TELEGRAM_WEBHOOK_SECRET выше.
  'RESEMBLE_WEBHOOK_SECRET',
];

/**
 * Переменные, значение которых показывать МОЖНО и нужно: в них нет
 * ничего, что стоило бы скрывать, а увидеть значение — единственный
 * способ ответить «настроено ли это правильно» с одного взгляда.
 *
 * Список ведётся руками СПЕЦИАЛЬНО: строка добавляется сюда только
 * вместе с осознанным ответом на вопрос «а это точно не секрет».
 */
const PUBLIC_VALUE_KEYS = [
  'PORT',
  'NODE_ENV',
  'BLOB_PUBLIC_HOSTS',
  'GEMINI_MODEL',
  'LAOZHANG_API_BASE_URL',
  'SERPAPI_DAILY_LIMIT_PER_USER',
  'YOUTUBE_SEARCH_DAILY_LIMIT_PER_USER',
  'AUDIT_AUTO_ITERATIONS_LIMIT',
  'PROJECT_LINE_ITEM_LIMIT',
  // Пятый аудит, Д-3.4: семь переменных тонкой настройки кронов этапов
  // 65–68 — тот же класс, что PROJECT_LINE_ITEM_LIMIT выше (тюнинг, не
  // секрет, видеть значение — единственный способ понять «настроено ли
  // это правильно» с одного взгляда).
  'CATALOG_BATCH_CRON_BATCH',
  'CATALOG_BATCH_MAX_ATTEMPTS',
  'AB_TEST_CRON_BATCH',
  'AB_TEST_MAX_ATTEMPTS',
  'PRODUCT_FEED_IMPORT_CRON_BATCH',
  'PRODUCT_FEED_IMPORT_MAX_ATTEMPTS',
  'PRODUCT_FEED_IMPORT_MAX_BYTES',
  'FFMPEG_API_BASE_URL',
  'VOICE_ID',
  'VOICE_MODEL',
  // doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md — переключатель провайдера и
  // голос Resemble по умолчанию, ни то ни другое не секрет (тот же
  // довод, что у VOICE_ID/VOICE_MODEL выше).
  'TTS_PROVIDER',
  'RESEMBLE_VOICE_ID',
  'PLANS_BILLING_ENABLED',
  'CORS_ORIGIN',
  'SESSION_TTL_HOURS',
  'ALLOW_DEV_AUTH',
  'DEV_USER_ID',
  // Этап 62: те же поля, что WayForPay кладёт в подписанную форму
  // покупки, которую и так видит плательщик — прятать их в админке
  // смысла нет (сам HMAC-секрет, WAYFORPAY_MERCHANT_SECRET, — выше).
  'WAYFORPAY_MERCHANT_ACCOUNT',
  'WAYFORPAY_DOMAIN',
  // Этап 73: публичный адрес стенда сам по себе не секрет — как раз
  // видеть его нужно, чтобы понять, соберётся ли callback_uri. Тот же
  // `API_PUBLIC_URL`, что уже собирает callback OAuth-каналов и вебхук
  // WayForPay — не отдельная переменная.
  'API_PUBLIC_URL',
];

/**
 * Переменные, которые функция читает, но чьё значение в ответ не
 * попадает даже будучи корректным: потолки пересчитываются в доллары, а
 * из имён прайса наружу уходят только сами имена.
 */
const OTHER_KEYS = [
  'VERCEL',
  // Вторая допустимая орфография той же настройки: пока задана
  // LAOZHANG_API_BASE_URL, эта не видна — она запасная, а не своя.
  // Отдельная проверка на неё — ниже.
  'OPENAI_API_BASE_URL',
  'DAILY_SPEND_LIMIT_USD_LITE',
  'DAILY_SPEND_LIMIT_USD_STANDARD',
  'DAILY_SPEND_LIMIT_USD_PREMIUM',
  'DAILY_SPEND_LIMIT_USD_ANONYMOUS',
  'AI_PRICE_GEMINI_2_5_FLASH_INPUT',
];

const ALL_KEYS = [...SECRET_KEYS, ...PUBLIC_VALUE_KEYS, ...OTHER_KEYS];

function envOf(keys: string[], extra: EnvLike = {}): EnvLike {
  const env: EnvLike = {};
  for (const key of keys) env[key] = marker(key);
  return { ...env, ...extra };
}

function find(results: EnvCheckResult[], key: string): EnvCheckResult {
  const row = results.find((r) => r.key === key || r.key.startsWith(`${key} `));
  if (!row) throw new Error(`нет проверки для ${key}`);
  return row;
}

describe('getEnvSettings — секреты наружу', () => {
  it('не отдаёт значение ни одной секретной переменной', () => {
    const results = getEnvSettings(envOf(SECRET_KEYS));
    const payload = JSON.stringify(results);
    const leaked = SECRET_KEYS.filter((key) => payload.includes(marker(key)));
    expect(leaked).toEqual([]);
  });

  it('наружу видны значения ровно тех переменных, которые названы несекретными', () => {
    // Общая защита вместо дисциплины автора: маркерами заданы ВСЕ
    // известные переменные, и мы смотрим, чьи значения дошли до ответа.
    const payload = JSON.stringify(getEnvSettings(envOf(ALL_KEYS)));
    const visible = ALL_KEYS.filter((key) => payload.includes(marker(key)));
    expect(visible.sort()).toEqual([...PUBLIC_VALUE_KEYS].sort());
  });

  it('запасная орфография базового URL тоже видна значением', () => {
    // OPENAI_API_BASE_URL — та же настройка под другим именем; она
    // показывается, когда основной не задан, и это тоже не секрет.
    const payload = JSON.stringify(
      getEnvSettings({ OPENAI_API_BASE_URL: marker('OPENAI_API_BASE_URL') }),
    );
    expect(payload).toContain(marker('OPENAI_API_BASE_URL'));
  });

  it('на пустом окружении не отдаёт ничего, кроме умолчаний', () => {
    // Умолчания — тоже часть ответа, и в них тоже нельзя протащить
    // секрет: проверяем, что пустой env вообще не роняет функцию и что
    // каждая строка отвечает на вопрос «задано ли».
    const results = getEnvSettings({});
    expect(results.length).toBeGreaterThan(30);
    for (const row of results) {
      expect(typeof row.message).toBe('string');
      expect(row.message.length).toBeGreaterThan(0);
      expect(['ok', 'warning', 'critical']).toContain(row.severity);
    }
  });
});

describe('getEnvSettings — ключи постобработки и озвучки (этапы 34–36)', () => {
  it('без FFMPEG_API_KEY честно жёлтый, а не зелёный', () => {
    // Ровно та находка, ради которой строка и заведена: человек, у
    // которого не работает обрезка, видел вкладку целиком зелёной и шёл
    // искать проблему не там.
    const row = find(getEnvSettings({}), 'FFMPEG_API_KEY');
    expect(row.set).toBe(false);
    expect(row.ok).toBe(false);
    expect(row.severity).toBe('warning');
    expect(row.message).toContain('Veo');
  });

  it('без VOICE_API_KEY тоже жёлтый — озвучки не будет, хотя ролик снимется', () => {
    const row = find(getEnvSettings({}), 'VOICE_API_KEY');
    expect(row.ok).toBe(false);
    expect(row.severity).toBe('warning');
  });

  it('с обоими ключами — зелено', () => {
    const results = getEnvSettings({
      FFMPEG_API_KEY: 'k',
      VOICE_API_KEY: 'k',
    });
    expect(find(results, 'FFMPEG_API_KEY').ok).toBe(true);
    expect(find(results, 'VOICE_API_KEY').ok).toBe(true);
  });

  it('VOICE_ID и VOICE_MODEL показывают умолчания, когда не заданы', () => {
    const results = getEnvSettings({});
    expect(find(results, 'VOICE_ID').value).toContain('по умолчанию');
    expect(find(results, 'VOICE_MODEL').value).toContain(
      'eleven_multilingual_v2',
    );
  });

  it('TTS_PROVIDER не задан — зелёный, откат на elevenlabs явно назван', () => {
    const row = find(getEnvSettings({}), 'TTS_PROVIDER');
    expect(row.ok).toBe(true);
    expect(row.value).toContain('elevenlabs');
  });

  it('TTS_PROVIDER=resemble — зелёный', () => {
    const row = find(
      getEnvSettings({ TTS_PROVIDER: 'resemble' }),
      'TTS_PROVIDER',
    );
    expect(row.ok).toBe(true);
    expect(row.severity).toBe('ok');
  });

  it('TTS_PROVIDER с неизвестным значением — предупреждение, не сбой', () => {
    const row = find(
      getEnvSettings({ TTS_PROVIDER: 'cartesia' }),
      'TTS_PROVIDER',
    );
    expect(row.ok).toBe(false);
    expect(row.severity).toBe('warning');
    expect(row.message).toContain('ElevenLabs');
  });

  it('без RESEMBLE_API_KEY — жёлтый; с ним — зелёный (тот же мягкий фоллбек, что у VOICE_API_KEY)', () => {
    expect(find(getEnvSettings({}), 'RESEMBLE_API_KEY').ok).toBe(false);
    expect(
      find(getEnvSettings({ RESEMBLE_API_KEY: 'k' }), 'RESEMBLE_API_KEY').ok,
    ).toBe(true);
  });

  it('RESEMBLE_VOICE_ID не задан — честно говорит, что умолчания у Resemble нет', () => {
    const row = find(getEnvSettings({}), 'RESEMBLE_VOICE_ID');
    expect(row.ok).toBe(true);
    expect(row.value).toContain('не задано');
  });

  it('FFMPEG_API_BASE_URL без схемы — предупреждение', () => {
    const row = find(
      getEnvSettings({ FFMPEG_API_BASE_URL: 'verygoodffmpeg.com/api' }),
      'FFMPEG_API_BASE_URL',
    );
    expect(row.ok).toBe(false);
  });
});

describe('getEnvSettings — BLOB_PUBLIC_HOSTS', () => {
  it('пустое значение объясняет, что проверка НЕ отключена', () => {
    const row = find(getEnvSettings({}), 'BLOB_PUBLIC_HOSTS');
    expect(row.ok).toBe(true);
    expect(row.message).toContain('не отключает');
  });

  it('хост со схемой или путём — предупреждение: он не совпадёт ни с чем', () => {
    for (const bad of ['https://blob.example.com', 'blob.example.com/x']) {
      const row = find(
        getEnvSettings({ BLOB_PUBLIC_HOSTS: bad }),
        'BLOB_PUBLIC_HOSTS',
      );
      expect(row.ok).toBe(false);
    }
  });

  it('список хостов показывается значением — иначе строка ни о чём не говорит', () => {
    const row = find(
      getEnvSettings({ BLOB_PUBLIC_HOSTS: 'a.example.com, b.example.com' }),
      'BLOB_PUBLIC_HOSTS',
    );
    expect(row.ok).toBe(true);
    expect(row.value).toBe('a.example.com, b.example.com');
  });
});

describe('getEnvSettings — режимы и деньги (§23, §26)', () => {
  it('PLANS_BILLING_ENABLED="1" — предупреждение: код читает это как «выключено»', () => {
    const row = find(
      getEnvSettings({ PLANS_BILLING_ENABLED: '1' }),
      'PLANS_BILLING_ENABLED',
    );
    expect(row.ok).toBe(false);
    expect(row.severity).toBe('warning');
  });

  it('потолки показывают ЭФФЕКТИВНОЕ значение, а не текст переменной', () => {
    const results = getEnvSettings({ DAILY_SPEND_LIMIT_USD_LITE: '7' });
    expect(find(results, 'DAILY_SPEND_LIMIT_USD_LITE').value).toBe(
      '$7 в сутки',
    );
    // Не заданный потолок показывает умолчание из того же кода, который
    // его и применяет.
    expect(find(results, 'DAILY_SPEND_LIMIT_USD_PREMIUM').value).toBe(
      '$30 в сутки',
    );
  });

  it('мусор в потолке не обнуляет его, но виден предупреждением', () => {
    const row = find(
      getEnvSettings({ DAILY_SPEND_LIMIT_USD_STANDARD: 'десять' }),
      'DAILY_SPEND_LIMIT_USD_STANDARD',
    );
    expect(row.ok).toBe(false);
    expect(row.value).toBe('$10 в сутки');
  });

  it('ноль — законное значение, но помечено: сервис выглядит сломанным', () => {
    const row = find(
      getEnvSettings({ DAILY_SPEND_LIMIT_USD_ANONYMOUS: '0' }),
      'DAILY_SPEND_LIMIT_USD_ANONYMOUS',
    );
    expect(row.ok).toBe(true);
    expect(row.severity).toBe('warning');
  });

  it('опечатка в имени ставки видна: переменная задана, а не влияет ни на что', () => {
    const row = find(
      getEnvSettings({ AI_PRICE_VEO_31_SECOND: '0.4' }),
      'AI_PRICE_*',
    );
    expect(row.ok).toBe(false);
    expect(row.message).toContain('AI_PRICE_VEO_31_SECOND');
  });

  it('правильное имя ставки принимается', () => {
    const row = find(
      getEnvSettings({ AI_PRICE_GEMINI_2_5_FLASH_INPUT: '0.3' }),
      'AI_PRICE_*',
    );
    expect(row.ok).toBe(true);
    expect(row.set).toBe(true);
  });

  it('нечисловая ставка не обнуляет прайс, но помечена', () => {
    const row = find(
      getEnvSettings({ AI_PRICE_GEMINI_2_5_FLASH_INPUT: 'дёшево' }),
      'AI_PRICE_*',
    );
    expect(row.ok).toBe(false);
  });
});

describe('getEnvSettings — предохранители прод-режима (не сломаны правками)', () => {
  it('ALLOW_DEV_AUTH=true вместе с production — критично', () => {
    const row = find(
      getEnvSettings({ ALLOW_DEV_AUTH: 'true', NODE_ENV: 'production' }),
      'ALLOW_DEV_AUTH',
    );
    expect(row.severity).toBe('critical');
  });

  it('на Vercel токены Blob не обязательны — там OIDC', () => {
    const row = find(getEnvSettings({ VERCEL: '1' }), 'BLOB_READ_WRITE_TOKEN');
    expect(row.ok).toBe(true);
    expect(row.required).toBe(false);
  });
});

describe('getEnvSettings — оплата (ТЗ §41, этап 62)', () => {
  it('без ключей все пять проверок жёлтые, а не критичные — фича опциональна', () => {
    const results = getEnvSettings({});
    for (const key of [
      'TELEGRAM_WEBHOOK_SECRET',
      'WAYFORPAY_MERCHANT_ACCOUNT',
      'WAYFORPAY_MERCHANT_SECRET',
      'WAYFORPAY_DOMAIN',
      'PAYMENT_TOKEN_KEY',
    ]) {
      const row = find(results, key);
      expect(row.ok).toBe(false);
      expect(row.severity).toBe('warning');
    }
  });

  it('PAYMENT_TOKEN_KEY правильного формата (32 байта base64) — зелёный', () => {
    const key = randomBytes(32).toString('base64');
    const row = find(
      getEnvSettings({ PAYMENT_TOKEN_KEY: key }),
      'PAYMENT_TOKEN_KEY',
    );
    expect(row.ok).toBe(true);
    expect(row.severity).toBe('ok');
  });

  it('PAYMENT_TOKEN_KEY не 32 байта — задан, но помечен предупреждением', () => {
    const row = find(
      getEnvSettings({ PAYMENT_TOKEN_KEY: 'слишкомкороткий' }),
      'PAYMENT_TOKEN_KEY',
    );
    expect(row.set).toBe(true);
    expect(row.ok).toBe(false);
    expect(row.severity).toBe('warning');
  });

  it('PLANS_BILLING_ENABLED не блокирует и не требует ключей оплаты', () => {
    // Независимые оси: PLANS_BILLING_ENABLED — про бесплатное
    // самостоятельное переключение режимов, ключи оплаты — про то, можно
    // ли вообще купить что-то. Ни одна проверка не должна ссылаться на
    // состояние другой.
    const withoutBilling = find(
      getEnvSettings({ WAYFORPAY_MERCHANT_ACCOUNT: 'shop' }),
      'WAYFORPAY_MERCHANT_ACCOUNT',
    );
    const withBilling = find(
      getEnvSettings({
        PLANS_BILLING_ENABLED: 'true',
        WAYFORPAY_MERCHANT_ACCOUNT: 'shop',
      }),
      'WAYFORPAY_MERCHANT_ACCOUNT',
    );
    expect(withoutBilling.ok).toBe(withBilling.ok);
    expect(withoutBilling.severity).toBe(withBilling.severity);
  });
});
