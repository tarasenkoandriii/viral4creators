/**
 * Story‑Tales: режим выпуска, матрица CTA и допуск материалов
 * (`src/lib/stories/release.ts`, `src/lib/stories/cta.ts`).
 *
 * Что здесь стережётся (ТЗ `doc/STORY-TALES-LANDING-SPEC.md` §5, §11, §15;
 * адаптация Р-STL-3/4/9):
 *
 *  1. Конфиг репозитория принят без ошибок и в v1 — `prep`.
 *  2. Неизвестный, битый, частично годный конфиг → `PREP_FALLBACK`.
 *  3. ST-LPL-01: при выключенном мастере нет «Создать сказку» и покупки.
 *  4. ST-LPL-02: без демо (или без плеера) нет Play и якоря «Пример».
 *  5. `wizardUrl` — только с TMA этого продукта или `t.me/<наш бот>/app`.
 *  6. ST-LPL-11: Kling/`benchmark-`/`sessions/`/`e64cdbd5…`/внешние хосты
 *     отвергаются в любом поле материала, и их нет в файлах страницы.
 *  7. Цены нет ни в одном режиме.
 *
 * Схема та же, что у остальных тестов лендинга: `node:assert` + `tsx`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BANNED_MATERIAL_TOKENS,
  PREP_FALLBACK,
  RELEASE_MODES,
  STORY_RELEASE_RAW,
  hasBannedToken,
  isAllowedMediaPath,
  isAllowedWizardUrl,
  loadStoryRelease,
  parseStoryRelease,
  type StoryMaterial,
  type StoryRelease,
} from '../src/lib/stories/release';
import {
  NO_APP_LINKS,
  V1_READINESS,
  appCta,
  effectiveMode,
  resolveStoryView,
  type StoryAppLinks,
  type StoryReadiness,
} from '../src/lib/stories/cta';

const ROOT = path.join(__dirname, '..');
const HOSTS = { tmaUrl: 'https://app.viral4creators.app', botUsername: 'v4c_bot' };
const READY: StoryReadiness = { playerReady: true, leadHandlerReady: true };
const TG = 'https://t.me/v4c_bot/app?startapp=e_stories';
const WEB = 'https://app.viral4creators.app?entry=stories#/stories';
const BOTH: StoryAppLinks = { telegramHref: TG, browserHref: WEB };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const base = (): Record<string, unknown> => clone(STORY_RELEASE_RAW) as Record<string, unknown>;
const DEMO: StoryMaterial = {
  url: '/stories-media/demo-ru-v1.mp4',
  posterUrl: '/stories-media/demo-ru-v1.jpg',
  locale: 'ru',
  durationSec: 42,
  title: 'Пример',
  excerpt: true,
  voiceOrigin: 'recorded',
  approvalId: 'STA-2026-001',
  source: 'Собственная съёмка',
  rights: 'Письменное согласие актёра',
};

/** Тот же материал без постера — для аудио, субтитров, транскрипта. */
const NO_POSTER: StoryMaterial = (({ posterUrl, ...rest }) => (void posterUrl, rest))(DEMO);

function accepted(value: Record<string, unknown>): StoryRelease {
  const { config, errors } = parseStoryRelease(value, HOSTS);
  assert.deepEqual(errors, [], JSON.stringify(value));
  return config;
}
function rejected(value: unknown, why: RegExp, label: string): void {
  const { config, errors } = parseStoryRelease(value, HOSTS);
  assert.ok(errors.length > 0, `${label}: конфиг принят`);
  assert.ok(errors.some((e) => why.test(e)), `${label}: нет причины ${why} в ${JSON.stringify(errors)}`);
  assert.deepEqual(config, PREP_FALLBACK, `${label}: откат не на prep`);
}

// ── 1. Конфиг репозитория ──────────────────────────────────────────────
{
  const config = accepted(base());
  assert.equal(config.releaseMode, 'prep', 'v1 выходит в режиме prep (Р-STL-4)');
  for (const key of ['demo', 'audioDemo', 'captions', 'transcript', 'wizardUrl'] as const) {
    assert.equal(config[key], null, `v1: ${key} = null`);
  }
  for (const key of [
    'leadFormEnabled',
    'wizardEnabled',
    'checkoutEnabled',
    'familyVoiceEnabled',
    'syntheticVideoEnabled',
    'catalogEnabled',
  ] as const) {
    assert.equal(config[key], false, `v1: ${key} = false`);
  }
  // Без хостов (боевые переменные не заданы) — тот же результат.
  const loaded = loadStoryRelease({ tmaUrl: 'http://localhost:5173', botUsername: null });
  assert.equal(loaded.releaseMode, 'prep');
  assert.equal(loaded.contentVersion, (STORY_RELEASE_RAW as { contentVersion: string }).contentVersion);
  // Р-STL-17: без бота и адреса TMA — безопасный откат на якорь.
  const view = resolveStoryView(loaded, V1_READINESS);
  assert.equal(view.mode, 'prep');
  assert.deepEqual(view.primary, { id: 'how', href: '#how' }, 'без ссылки в приложение основной CTA — «Как это работает» якорем');
  assert.deepEqual(view.secondary, []);
  // С ботом — «Открыть в Telegram» в раздел #/stories, якорь вторым.
  const withBot = resolveStoryView(loaded, V1_READINESS, { telegramHref: TG, browserHref: WEB });
  assert.deepEqual(withBot.primary, { id: 'telegram', href: TG });
  assert.deepEqual(withBot.secondary, [{ id: 'how', href: '#how' }]);
}

// ── 2. Битый и неизвестный конфиг → prep ───────────────────────────────
rejected(null, /объект/, 'null');
rejected('prep', /объект/, 'строка');
rejected([], /объект/, 'массив');
rejected({ ...base(), releaseMode: 'beta' }, /releaseMode/, 'неизвестный режим');
rejected({ ...base(), releaseMode: undefined }, /releaseMode/, 'без режима');
rejected({ ...base(), price: 990 }, /price: неизвестное поле/, 'лишнее поле (цена)');
{
  const v = base();
  delete v.checkoutEnabled;
  rejected(v, /checkoutEnabled: обязательное/, 'пропущенный флаг');
}
rejected({ ...base(), wizardEnabled: 'yes' }, /wizardEnabled/, 'флаг строкой');
rejected({ ...base(), locales: ['ru', 'uk'] }, /locales/, 'не все пять локалей');
rejected({ ...base(), locales: ['ru', 'uk', 'en', 'de', 'fr'] }, /locales/, 'чужая локаль');
rejected({ ...base(), contentVersion: '  ' }, /contentVersion/, 'пустая версия');
rejected({ ...base(), legalLinks: { offer: 'offer', terms: 'terms-of-use' } }, /privacy/, 'без ссылки приватности');
rejected(
  { ...base(), legalLinks: { offer: 'offer', terms: 'terms-of-use', privacy: 'privacy' } },
  /нет страницы \/legal\/privacy/,
  'ссылка на несуществующий документ',
);
rejected(
  { ...base(), legalLinks: { offer: 'offer', terms: 'terms-of-use', privacy: 'terms-of-use', narratorConsent: '' } },
  /narratorConsent/,
  'пустая заглушка согласия',
);
// Любой режим, отвергнутый проверкой, — полный prep, а не «частично».
for (const mode of RELEASE_MODES) {
  rejected({ ...base(), releaseMode: mode, demo: { ...DEMO, approvalId: '' } }, /approvalId/, `${mode} с неодобренным демо`);
}

// ── 3–4, 7. Матрица режимов ────────────────────────────────────────────
{
  const wizardUrl = 'https://app.viral4creators.app/?entry=stories';
  const cfg = (patch: Partial<StoryRelease>): StoryRelease => accepted({ ...base(), ...patch });

  type Row = {
    name: string;
    config: StoryRelease;
    readiness: StoryReadiness;
    links?: StoryAppLinks;
    mode: string;
    primary: string;
    secondary: string[];
    play: boolean;
    lead: boolean;
    checkout: boolean;
  };
  const rows: Row[] = [
    // prep — всегда «Как это работает», ничего лишнего.
    { name: 'prep', config: cfg({}), readiness: READY, mode: 'prep', primary: 'how', secondary: [], play: false, lead: false, checkout: false },
    // prep с демо в конфиге: режим главнее — демо не показываем.
    { name: 'prep+demo', config: cfg({ demo: DEMO }), readiness: READY, mode: 'prep', primary: 'how', secondary: [], play: false, lead: false, checkout: false },
    // Р-STL-17: prep с разделом приложения — «Открыть в Telegram»
    // основным, «Как это работает» вторым; без бота — браузерный адрес;
    // без обоих или с чужим адресом — откат на якорь.
    { name: 'prep+Telegram', config: cfg({}), readiness: READY, links: BOTH, mode: 'prep', primary: 'telegram', secondary: ['how'], play: false, lead: false, checkout: false },
    { name: 'prep+браузер', config: cfg({}), readiness: READY, links: { telegramHref: null, browserHref: WEB }, mode: 'prep', primary: 'app', secondary: ['how'], play: false, lead: false, checkout: false },
    { name: 'prep без ссылок', config: cfg({}), readiness: READY, links: NO_APP_LINKS, mode: 'prep', primary: 'how', secondary: [], play: false, lead: false, checkout: false },
    { name: 'prep+чужие ссылки', config: cfg({}), readiness: READY, links: { telegramHref: 'https://t.me/v4c_bot/app?startapp=e_greetings', browserHref: 'https://app.viral4creators.app?entry=greetings#/projects/new' }, mode: 'prep', primary: 'how', secondary: [], play: false, lead: false, checkout: false },
    { name: 'prep+демо+Telegram', config: cfg({ demo: DEMO, leadFormEnabled: true }), readiness: READY, links: BOTH, mode: 'prep', primary: 'telegram', secondary: ['how'], play: false, lead: false, checkout: false },
    // Ссылка в приложение не делает «Создать сказку» без мастера.
    { name: 'wizard без флага+Telegram', config: cfg({ releaseMode: 'wizard', wizardUrl: 'https://app.viral4creators.app/?entry=stories' }), readiness: READY, links: BOTH, mode: 'prep', primary: 'telegram', secondary: ['how'], play: false, lead: false, checkout: false },
    { name: 'wizard+Telegram', config: cfg({ releaseMode: 'wizard', wizardEnabled: true, wizardUrl: 'https://app.viral4creators.app/?entry=stories' }), readiness: READY, links: BOTH, mode: 'wizard', primary: 'create', secondary: ['how'], play: false, lead: false, checkout: false },
    // pilot без демо → prep (нет Play).
    { name: 'pilot без демо', config: cfg({ releaseMode: 'pilot' }), readiness: READY, mode: 'prep', primary: 'how', secondary: [], play: false, lead: false, checkout: false },
    // pilot с демо, но без плеера (v1) → prep.
    { name: 'pilot, плеер не готов', config: cfg({ releaseMode: 'pilot', demo: DEMO }), readiness: V1_READINESS, mode: 'prep', primary: 'how', secondary: [], play: false, lead: false, checkout: false },
    // pilot с демо и плеером: «Посмотреть пример» + «Как это работает».
    { name: 'pilot', config: cfg({ releaseMode: 'pilot', demo: DEMO }), readiness: READY, mode: 'pilot', primary: 'example', secondary: ['how'], play: true, lead: false, checkout: false },
    // pilot + форма включена, но обработчика нет → без формы.
    { name: 'pilot+форма без обработчика', config: cfg({ releaseMode: 'pilot', demo: DEMO, leadFormEnabled: true }), readiness: { playerReady: true, leadHandlerReady: false }, mode: 'pilot', primary: 'example', secondary: ['how'], play: true, lead: false, checkout: false },
    // pilot + форма + обработчик → «Узнать о запуске».
    { name: 'pilot+форма', config: cfg({ releaseMode: 'pilot', demo: DEMO, leadFormEnabled: true }), readiness: READY, mode: 'pilot', primary: 'example', secondary: ['how', 'lead'], play: true, lead: true, checkout: false },
    // wizard без флага / без адреса → ниже.
    { name: 'wizard без флага', config: cfg({ releaseMode: 'wizard', wizardUrl }), readiness: READY, mode: 'prep', primary: 'how', secondary: [], play: false, lead: false, checkout: false },
    { name: 'wizard без адреса', config: cfg({ releaseMode: 'wizard', wizardEnabled: true }), readiness: READY, mode: 'prep', primary: 'how', secondary: [], play: false, lead: false, checkout: false },
    { name: 'wizard без адреса, с демо', config: cfg({ releaseMode: 'wizard', wizardEnabled: true, demo: DEMO }), readiness: READY, mode: 'pilot', primary: 'example', secondary: ['how'], play: true, lead: false, checkout: false },
    // wizard: «Создать сказку» → адрес мастера, без покупки.
    { name: 'wizard', config: cfg({ releaseMode: 'wizard', wizardEnabled: true, wizardUrl }), readiness: READY, mode: 'wizard', primary: 'create', secondary: ['how'], play: false, lead: false, checkout: false },
    { name: 'wizard+демо', config: cfg({ releaseMode: 'wizard', wizardEnabled: true, wizardUrl, demo: DEMO }), readiness: READY, mode: 'wizard', primary: 'create', secondary: ['example'], play: true, lead: false, checkout: false },
    // checkout без режима commercial — не покупка.
    { name: 'wizard+checkout', config: cfg({ releaseMode: 'wizard', wizardEnabled: true, wizardUrl, checkoutEnabled: true }), readiness: READY, mode: 'wizard', primary: 'create', secondary: ['how'], play: false, lead: false, checkout: false },
    // commercial без checkout → wizard; без мастера → prep.
    { name: 'commercial без оплаты', config: cfg({ releaseMode: 'commercial', wizardEnabled: true, wizardUrl }), readiness: READY, mode: 'wizard', primary: 'create', secondary: ['how'], play: false, lead: false, checkout: false },
    { name: 'commercial без мастера', config: cfg({ releaseMode: 'commercial', checkoutEnabled: true }), readiness: READY, mode: 'prep', primary: 'how', secondary: [], play: false, lead: false, checkout: false },
    { name: 'commercial', config: cfg({ releaseMode: 'commercial', wizardEnabled: true, wizardUrl, checkoutEnabled: true }), readiness: READY, mode: 'commercial', primary: 'create', secondary: ['how'], play: false, lead: false, checkout: true },
  ];
  for (const row of rows) {
    const view = resolveStoryView(row.config, row.readiness, row.links ?? NO_APP_LINKS);
    assert.equal(effectiveMode(row.config, row.readiness), view.mode, row.name);
    assert.equal(view.mode, row.mode, `${row.name}: режим`);
    assert.equal(view.primary.id, row.primary, `${row.name}: основной CTA`);
    assert.deepEqual(view.secondary.map((c) => c.id), row.secondary, `${row.name}: вторичные`);
    assert.equal(view.showPlay, row.play, `${row.name}: Play`);
    assert.equal(view.showExampleNav, row.play, `${row.name}: якорь «Пример»`);
    assert.equal(view.showLeadForm, row.lead, `${row.name}: форма`);
    assert.equal(view.showCheckout, row.checkout, `${row.name}: покупка`);
    // §6.9: цены нет ни в одном режиме — её нет и в данных.
    assert.equal(view.showPrice, false, `${row.name}: цена`);
    // ST-LPL-01: «Создать сказку» — только при мастере, и ведёт на него.
    const all = [view.primary, ...view.secondary];
    const create = all.find((c) => c.id === 'create');
    if (view.mode === 'wizard' || view.mode === 'commercial') {
      assert.equal(create?.href, wizardUrl, `${row.name}: «Создать» ведёт в мастер`);
    } else {
      assert.equal(create, undefined, `${row.name}: «Создать сказку» без мастера`);
      assert.equal(view.showCheckout, false, `${row.name}: покупка без мастера`);
    }
    // Раздел приложения — только метка stories, и только основным в prep.
    for (const cta of all.filter((c) => c.id === 'telegram' || c.id === 'app')) {
      assert.match(cta.href, /startapp=e_stories$|\?entry=stories#\/stories$/, `${row.name}: ${cta.href}`);
    }
    // ST-LPL-02: «Посмотреть пример» — только с демо и плеером.
    if (!view.showPlay) assert.ok(!all.some((c) => c.id === 'example'), `${row.name}: «пример» без демо`);
    // Якоря — только существующие блоки страницы.
    for (const cta of all) {
      if (cta.href.startsWith('#')) assert.match(cta.href, /^#(how|example|launch)$/, `${row.name}: ${cta.href}`);
    }
  }
}

// ── 4б. Ссылка в раздел приложения ─────────────────────────────────────
{
  assert.deepEqual(appCta(BOTH), { id: 'telegram', href: TG });
  assert.deepEqual(appCta({ telegramHref: `${TG}__r_ABCD2345`, browserHref: null }), { id: 'telegram', href: `${TG}__r_ABCD2345` });
  assert.deepEqual(appCta({ telegramHref: null, browserHref: WEB }), { id: 'app', href: WEB });
  for (const bad of [
    'https://t.me/v4c_bot/app?startapp=e_ads',
    'http://t.me/v4c_bot/app?startapp=e_stories',
    'https://t.me.evil.com/v4c_bot/app?startapp=e_stories',
    'https://app.viral4creators.app?entry=stories&child=x#/stories',
    'https://app.viral4creators.app?entry=stories#/projects/new',
    'javascript:alert(1)//?entry=stories#/stories',
  ]) {
    assert.equal(appCta({ telegramHref: bad, browserHref: bad }), null, bad);
  }
  assert.equal(appCta(NO_APP_LINKS), null);
}

// ── 5. Адрес мастера ───────────────────────────────────────────────────
{
  const ok = [
    'https://app.viral4creators.app/',
    'https://app.viral4creators.app/?entry=stories',
    'https://app.viral4creators.app/?entry=stories#/stories',
    'https://t.me/v4c_bot/app',
    'https://t.me/v4c_bot/app?startapp=e_stories',
    'https://t.me/v4c_bot/app?startapp=e_stories__r_ABCD2345',
    'https://app.viral4creators.app/#/projects/new',
    'https://app.viral4creators.app/?entry=greetings#/projects/new',
  ];
  for (const url of ok) assert.ok(isAllowedWizardUrl(url, HOSTS), url);
  const bad = [
    null,
    '',
    'app.viral4creators.app',
    'http://app.viral4creators.app/',
    'https://evil.example.com/',
    'https://app.viral4creators.app.evil.com/',
    'https://user:pass@app.viral4creators.app/',
    'https://app.viral4creators.app:8443/',
    'https://app.viral4creators.app/?entry=stories&child=Маша',
    'https://app.viral4creators.app/?email=a@b.c',
    'https://t.me/other_bot/app',
    'https://t.me/v4c_bot',
    'https://t.me/v4c_bot/app?start=x',
    // Находка S3-1 аудита: данные в пути, фрагменте и значениях меток.
    'https://app.viral4creators.app/child/masha?entry=Masha_Ivanova_5let#/stories?name=Masha&email=a@b.c',
    'https://app.viral4creators.app/child/masha',
    'https://app.viral4creators.app/?entry=Masha_Ivanova_5let',
    'https://app.viral4creators.app/?entry=stories#/stories?name=Masha',
    'https://app.viral4creators.app/?entry=stories#/projects/p1',
    'https://app.viral4creators.app/?entry=stories&entry=ads',
    'https://app.viral4creators.app/?ref=ABCD2345',
    'https://t.me/v4c_bot/app?startapp=name_Masha',
    'https://t.me/v4c_bot/app?startapp=e_shop',
    'https://t.me/v4c_bot/app?startapp=e_stories__r_bad',
    'https://t.me/v4c_bot/app?startapp=e_stories&startapp=e_ads',
    'https://t.me/v4c_bot/app?startapp=e_stories#x',
    'javascript:alert(1)',
    'https://app.viral4creators.app/sessions/benchmark-kling-1',
  ];
  for (const url of bad) assert.equal(isAllowedWizardUrl(url, HOSTS), false, String(url));
  // TMA на localhost-дефолте — не «наш хост»: мастер не включится случайно.
  assert.equal(isAllowedWizardUrl('http://localhost:5173/', { tmaUrl: 'http://localhost:5173', botUsername: null }), false);
  // Бот не задан — t.me не разрешён.
  assert.equal(isAllowedWizardUrl('https://t.me/v4c_bot/app', { ...HOSTS, botUsername: null }), false);
  rejected({ ...base(), wizardUrl: 'https://evil.example.com/' }, /wizardUrl/, 'чужой мастер');
}

// ── 6. Материалы: только одобренные, только свои, без Kling ───────────
{
  accepted({ ...base(), releaseMode: 'pilot', demo: DEMO });
  accepted({ ...base(), audioDemo: { ...NO_POSTER, url: '/stories-media/audio/demo-ru-v1.m4a' } });

  const external = [
    'https://cdn.example.com/demo.mp4',
    '//cdn.example.com/demo.mp4',
    'https://abc.public.blob.vercel-storage.com/stories/demo.mp4',
    '/stories-media/../secret.mp4',
    '/stories-media//demo.mp4',
    '/stories-media/demo.mp4?x=1',
    '/public/stories-media/demo.mp4',
    'stories-media/demo.mp4',
    '/media/demo.mp4',
  ];
  for (const url of external) {
    assert.equal(isAllowedMediaPath(url), false, url);
    rejected({ ...base(), demo: { ...DEMO, url } }, /demo\.url/, `внешний адрес ${url}`);
  }
  rejected({ ...base(), demo: { ...DEMO, posterUrl: 'https://cdn.example.com/p.jpg' } }, /posterUrl/, 'внешний постер');
  rejected({ ...base(), captions: { ...DEMO } }, /captions\.posterUrl/, 'постер не у demo');

  // Забракованный образец — по любому признаку, в любом поле, любым регистром.
  const kling = [
    '/stories-media/kling-demo.mp4',
    '/stories-media/KLING.mp4',
    '/stories-media/benchmark-kling-c9ae6a7dce8e6ab98bed5f97aa2de753.mp4',
    '/stories-media/sessions/x.mp4',
    '/stories-media/generated-e64cdbd5-7364-40a8-927b-7c26c760a844.mp4',
  ];
  for (const url of kling) {
    assert.ok(hasBannedToken(url), url);
    rejected({ ...base(), demo: { ...DEMO, url } }, /demo\.url/, `запрещённый ${url}`);
  }
  // В идентификаторе одобрения — отказ; во всех полях-адресах — тоже
  // (выше, `demo.url`, `posterUrl`).
  for (const approvalId of ['kling-ok-1', 'benchmark-kling-c9ae6a7dce8e6ab98bed5f97aa2de753', 'e64cdbd5-7364-40a8-927b-7c26c760a844']) {
    rejected({ ...base(), demo: { ...DEMO, approvalId } }, /demo\.approvalId: запрещённый/, `approvalId ${approvalId}`);
  }
  rejected(
    { ...base(), demo: { ...DEMO, posterUrl: '/stories-media/kling-poster.jpg' } },
    /demo\.posterUrl/,
    'Kling в постере',
  );
  rejected(
    { ...base(), captions: { ...NO_POSTER, url: '/stories-media/sessions/demo.vtt' } },
    /captions\.url/,
    'sessions/ в адресе субтитров',
  );
  rejected(
    { ...base(), transcript: { ...NO_POSTER, url: '/stories-media/benchmark-kling.txt' } },
    /transcript\.url/,
    'Kling в адресе транскрипта',
  );
  // Свободный текст не проверяется (находка S3-2): немецкое «klingt» —
  // не след образца, и конфиг из-за названия не отвергается.
  accepted({ ...base(), releaseMode: 'pilot', demo: { ...DEMO, locale: 'de', title: 'So klingt Oma' } });
  accepted({ ...base(), demo: { ...DEMO, source: 'Eigene Aufnahme, klingt warm', rights: 'Zustimmung — so klingt es' } });

  // Обязательные поля одобрения и происхождения.
  for (const field of ['approvalId', 'source', 'rights', 'title'] as const) {
    const demo: Record<string, unknown> = { ...DEMO };
    delete demo[field];
    rejected({ ...base(), demo }, new RegExp(`demo\\.${field}`), `без ${field}`);
  }
  rejected({ ...base(), demo: { ...DEMO, durationSec: 0 } }, /durationSec/, 'нулевая длительность');
  rejected({ ...base(), demo: { ...DEMO, voiceOrigin: 'clone' } }, /voiceOrigin/, 'неизвестное происхождение голоса');
  rejected({ ...base(), demo: { ...DEMO, locale: 'fr' } }, /locale/, 'чужая локаль материала');
  rejected({ ...base(), demo: { ...DEMO, extra: 1 } }, /demo\.extra/, 'лишнее поле материала');
}

// ── 6б. В файлах страницы и в public нет следа забракованного образца ──
{
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(path.join(ROOT, 'src', 'app', '[locale]', 'stories'));
  walk(path.join(ROOT, 'src', 'lib', 'stories', 'copy'));
  walk(path.join(ROOT, 'public', 'stories-media'));
  files.push(
    path.join(ROOT, 'src', 'lib', 'stories', 'release.json'),
    path.join(ROOT, 'src', 'lib', 'stories', 'cta.ts'),
    path.join(ROOT, 'src', 'lib', 'stories-host.ts'),
  );
  assert.ok(files.length >= 10, `файлов страницы подозрительно мало: ${files.length}`);
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    assert.equal(hasBannedToken(rel), false, `имя файла: ${rel}`);
    const text = fs.readFileSync(file, 'utf8').toLowerCase();
    for (const token of BANNED_MATERIAL_TOKENS) {
      // В прозе `kling` — только отдельным словом: немецкое «klingt»
      // («звучит») в текстах страницы — не след образца. В полях
      // материалов (`hasBannedToken`) сверка строже — подстрокой.
      const found =
        token === 'kling' ? /(?<![a-z])kling(?![a-z])/.test(text) : text.includes(token);
      assert.ok(!found, `${rel}: «${token}»`);
    }
  }
  // Конфиг: ни одного внешнего адреса (мастер в v1 — null).
  const rawJson = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'stories', 'release.json'), 'utf8');
  assert.doesNotMatch(rawJson, /https?:\/\/|\/\/[a-z]/i, 'release.json: внешний адрес');
}

console.log(
  'stories-release: конфиг v1 = prep, откат битого конфига, матрица prep/pilot/wizard/commercial, адрес мастера, допуск материалов и запрет Kling проверены',
);
