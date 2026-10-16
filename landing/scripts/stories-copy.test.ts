/**
 * Story‑Tales: тексты пяти локалей (`src/lib/stories/copy`).
 *
 *  1. Паритет (ST-LPL-06, решение 16.10): у ru/uk/en/de/es одинаковые
 *     ключи, одинаковая длина каждого списка, ни одной пустой строки.
 *  2. Заголовок, подзаголовок, микротекст и подписи CTA RU/UK — дословно
 *     из ТЗ §6.2 и §7; FAQ RU — ровно десять обязательных вопросов §6.10.
 *  3. Запреты (§3, §6.8, §6.9, §8): гарантии, отзывы/рейтинги, проценты и
 *     цифры вообще (цены, таймеры, «N осталось»), валюты, «бесплатно»,
 *     дефицит, обещания сна/речи/терапии, «полностью приватно», военная
 *     лексика и страх; подпись «Иллюстрация формата» есть на всех языках.
 *  4. Марка — с неразрывным дефисом (Р-STL-11).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { locales } from '../src/lib/i18n';
import { BRAND, STORIES_COPY } from '../src/lib/stories/copy';

const SPEC = path.join(__dirname, '..', '..', 'doc', 'STORY-TALES-LANDING-SPEC.md');

// ── 1. Паритет ─────────────────────────────────────────────────────────
type Shape = string | Shape[] | { [k: string]: Shape };
function shape(value: unknown, at: string, strings: Array<[string, string]>): Shape {
  if (typeof value === 'string') {
    strings.push([at, value]);
    return 'string';
  }
  if (Array.isArray(value)) return value.map((v, i) => shape(v, `${at}[${i}]`, strings));
  assert.ok(value && typeof value === 'object', `${at}: не строка/список/объект`);
  return Object.fromEntries(
    Object.keys(value as object)
      .sort()
      .map((k) => [k, shape((value as Record<string, unknown>)[k], `${at}.${k}`, strings)]),
  );
}

const strings = new Map<string, Array<[string, string]>>();
const reference = (() => {
  const list: Array<[string, string]> = [];
  const s = shape(STORIES_COPY.ru, 'ru', list);
  strings.set('ru', list);
  return s;
})();
for (const locale of locales) {
  if (locale === 'ru') continue;
  const list: Array<[string, string]> = [];
  assert.deepEqual(shape(STORIES_COPY[locale], 'ru', list), reference, `${locale}: форма текстов отличается от ru`);
  strings.set(locale, list);
}
for (const [locale, list] of strings) {
  for (const [at, value] of list) {
    assert.ok(value.trim().length > 0, `${locale}: пустая строка ${at}`);
    assert.equal(value, value.trim(), `${locale}: пробелы по краям ${at}`);
  }
}
const ru = STORIES_COPY.ru;
assert.equal(ru.example.parts.length, 3, 'пример — три части');
assert.equal(ru.audience.items.length, 3, 'три сценария аудитории (§3)');
assert.equal(ru.how.steps.length, 4, 'четыре шага (§6.5)');
assert.equal(ru.narrator.items.length, 3, 'три пункта о рассказчике (§6.6)');
assert.equal(ru.faq.items.length, 10, 'десять вопросов (§6.10)');

// ── 2. Дословно из ТЗ ──────────────────────────────────────────────────
const exact = {
  ru: {
    title: 'Подарите сказку с обращением близкого человека',
    subtitle:
      'Запишите несколько тёплых слов. Продолжением станет иллюстрированная сказка с выбранным рассказчиком — маленький подарок, который можно включать снова',
    micro: 'Готовит взрослый · Получает семья · Без детского чата',
    // «Узнать о пилоте» ТЗ §7 заменено решением 16.10 (Р-STL-15: слова
    // «пилот» на странице нет); «Открыть в Telegram» — Р-STL-17.
    cta: {
      how: 'Как это работает',
      example: 'Посмотреть пример',
      lead: 'Узнать о запуске',
      create: 'Создать сказку',
      telegram: 'Открыть в Telegram',
      app: 'Открыть приложение',
    },
    badge: 'Скоро запуск',
    caption: 'Иллюстрация формата',
  },
  uk: {
    title: 'Подаруйте казку зі зверненням близької людини',
    subtitle:
      'Запишіть кілька теплих слів. Продовженням стане ілюстрована казка з обраним оповідачем — маленький подарунок, який можна вмикати знову',
    micro: 'Готує дорослий · Отримує родина · Без дитячого чату',
    cta: {
      how: 'Як це працює',
      example: 'Переглянути приклад',
      lead: 'Дізнатися про запуск',
      create: 'Створити казку',
      telegram: 'Відкрити в Telegram',
      app: 'Відкрити застосунок',
    },
  },
} as const;
for (const locale of ['ru', 'uk'] as const) {
  const t = STORIES_COPY[locale];
  const e = exact[locale];
  assert.equal(t.hero.title, e.title, `${locale}: заголовок не из ТЗ`);
  assert.ok(t.hero.subtitle === e.subtitle || t.hero.subtitle === `${e.subtitle}.`, `${locale}: подзаголовок не из ТЗ`);
  assert.equal(t.hero.micro, e.micro, `${locale}: микротекст не из ТЗ`);
  assert.deepEqual(t.cta, e.cta, `${locale}: подписи CTA не из ТЗ`);
}
assert.equal(ru.hero.badge, exact.ru.badge);
assert.equal(ru.catalog.status, 'Каталог готовится');
assert.equal(ru.launch.title, 'Запуск');
assert.equal(ru.how.appLink, 'Посмотреть раздел в приложении');

// Р-STL-16: слоган владельца — дословно, на каждом языке.
const TAGLINES = {
  ru: 'Всё лучшее — детям',
  uk: 'Усе найкраще — дітям',
  en: 'All the best for children',
  de: 'Das Beste für die Kinder',
  es: 'Lo mejor para los niños',
} as const;
// Р-STL-17: основной CTA — раздел в Telegram.
const TELEGRAM_CTA = {
  ru: 'Открыть в Telegram',
  uk: 'Відкрити в Telegram',
  en: 'Open in Telegram',
  de: 'In Telegram öffnen',
  es: 'Abrir en Telegram',
} as const;
// Решение 16.10 п.4: ответ о цене — без пилота, с этой фразой.
const PRICE_FAQ = {
  ru: 'Цена появится к запуску; сейчас ничего не продаётся и не списывается.',
  uk: 'Ціна з’явиться до запуску; зараз нічого не продається і не списується.',
  en: 'The price will be announced at launch; nothing is sold or charged right now.',
  de: 'Der Preis kommt zum Start; derzeit wird nichts verkauft und nichts abgebucht.',
  es: 'El precio llegará con el lanzamiento; ahora no se vende ni se cobra nada.',
} as const;
for (const locale of locales) {
  const t = STORIES_COPY[locale];
  assert.equal(t.tagline, TAGLINES[locale], `${locale}: слоган`);
  assert.equal(t.cta.telegram, TELEGRAM_CTA[locale], `${locale}: «Открыть в Telegram»`);
  assert.ok(t.faq.items[8].answer.startsWith(PRICE_FAQ[locale]), `${locale}: ответ о цене`);
  // Подпись у кнопки: профиль рассказчика (образ и голос) уже есть,
  // сказка — позже.
  assert.ok(t.hero.appNote.length > 40, `${locale}: подпись у кнопки приложения`);
}
// S3-3: FAQ о ещё не работающем — будущим временем, без настоящего.
const PRESENT: Record<string, RegExp> = {
  ru: /начинается|сказку читает|готовит взрослый|получает готовый|не нужен ни|не попадает/u,
  uk: /починається|казку читає|готує дорослий|отримує готовий|не потрібні ні|не потрапляє/u,
  en: /\bstarts\b|\bis read by\b|\bprepares\b|\breceives\b|\bneeds neither\b|does not go/u,
  de: /\bbeginnt\b|liest der|bereitet .* vor|erhält das fertige|braucht weder|kommt in keinen/u,
  es: /empieza justo|lo lee el|lo prepara un|recibe el resultado|no necesita ni|no entra en/u,
};
for (const locale of locales) {
  for (const i of [0, 1, 4, 9]) {
    const answer = STORIES_COPY[locale].faq.items[i].answer;
    assert.doesNotMatch(answer, PRESENT[locale], `${locale}: FAQ ${i + 1} — настоящее время о несуществующем: «${answer}»`);
  }
}
// S3-4: немецкий микротекст с дополнением, без двусмысленного «Sie klont»;
// естественный испанский CTA; одно написание Киева в каждой латинской локали.
assert.equal(STORIES_COPY.de.hero.micro, 'Ein Erwachsener gestaltet · Die Familie erhält das Geschenk · Kein Kinderchat');
assert.match(STORIES_COPY.de.meta.description, /die Familie erhält das Geschenk\.$/u);
assert.doesNotMatch(STORIES_COPY.de.faq.items[2].answer, /Sie klont/u);
assert.equal(STORIES_COPY.es.cta.lead, 'Avisarme del lanzamiento');
for (const [locale, city] of [['en', 'Kyiv'], ['de', 'Kyjiw'], ['es', 'Kyiv']] as const) {
  const all = strings.get(locale)!.map(([, v]) => v).join('\n');
  assert.ok(all.includes(city), `${locale}: нет «${city}»`);
  assert.doesNotMatch(all.replace(city, ''), /Kiev|Kyiv|Kyjiw|Kiew/u, `${locale}: второе написание города`);
}
// Р-STL-19: оператор без отсылки к незаполненным реквизитам оферты.
for (const locale of locales) {
  assert.doesNotMatch(STORIES_COPY[locale].footer.operator, /Реквизит|Реквізит|Details|Angaben|Datos/u, `${locale}: реквизиты`);
}

assert.match(ru.hero.appNote, /профиль рассказчика.*фото или скетч.*голос.*Создание сказки появится позже/u);

// Те же строки действительно стоят в ТЗ (если документ рядом).
if (fs.existsSync(SPEC)) {
  const spec = fs.readFileSync(SPEC, 'utf8');
  for (const value of [exact.ru.title, exact.ru.subtitle, exact.ru.micro, exact.uk.title, exact.uk.subtitle, exact.uk.micro]) {
    assert.ok(spec.includes(value), `в ТЗ нет строки «${value}»`);
  }
  const faqBlock = spec.slice(spec.indexOf('### 6.10. FAQ'), spec.indexOf('### 6.11.'));
  const questions = [...faqBlock.matchAll(/^- (.+\?)$/gm)].map((m) => m[1]);
  assert.equal(questions.length, 10, 'в ТЗ §6.10 не десять вопросов');
  assert.deepEqual(
    ru.faq.items.map((i) => i.question),
    questions,
    'FAQ RU — не те десять вопросов §6.10 (или не в том порядке)',
  );
} else {
  console.log('stories-copy: doc/ рядом нет — сверка с ТЗ пропущена');
}

// Видимая подпись иллюстрации — на каждом языке своя, не пустая и не русская.
const captions = new Set(locales.map((l) => STORIES_COPY[l].hero.illustrationCaption));
assert.equal(captions.size, locales.length, 'подпись «Иллюстрация формата» не переведена');

// ── 3. Запреты ─────────────────────────────────────────────────────────
const L = '\\p{L}';
const word = (stem: string) => new RegExp(`(?<!${L})(?:${stem})`, 'iu');
const whole = (w: string) => new RegExp(`(?<!${L})(?:${w})(?!${L})`, 'iu');
const FORBIDDEN: Array<[RegExp, string]> = [
  // Р-STL-15: рамки «пилота» на странице нет — только «запуск/скоро».
  [word('пилот|пілот|pilot|piloto'), '«пилот»'],
  [/\d/u, 'цифры (цены, проценты, таймеры, «N мест»)'],
  [/%|٪/u, 'проценты'],
  [/[₴$€₽£¥]/u, 'знак валюты'],
  [whole('(грн|руб|uah|usd|eur|euro|dollars?)'), 'валюта'],
  [word('гарант'), 'гарантии'],
  [word('гаранті'), 'гарантии'],
  [word('guarant'), 'guarantee'],
  [word('garant'), 'Garantie/garantía'],
  [word('отзыв'), 'отзывы'],
  [word('відгук'), 'відгуки'],
  [whole('reviews?'), 'reviews'],
  [word('testimon'), 'testimonials'],
  [word('bewertung'), 'Bewertungen'],
  [word('erfahrungsbericht'), 'Erfahrungsberichte'],
  [word('rezension'), 'Rezensionen'],
  [word('reseñ'), 'reseñas'],
  [word('opiniones'), 'opiniones'],
  [word('рейтинг'), 'рейтинг'],
  [word('rating'), 'rating'],
  [word('звёзд|зірк|stars?(?!\\p{L})|sterne|estrellas'), 'звёзды'],
  [word('бесплатн'), 'бесплатно'],
  [word('безкоштовн'), 'безкоштовно'],
  [whole('free'), 'free'],
  [word('kostenlos|gratis|umsonst'), 'kostenlos/gratis'],
  [word('скидк|знижк|discount|rabatt|descuento|акци[яи]'), 'скидки'],
  [word('таймер|timer|countdown|осталось|лишилось|only\\s+\\p{L}+\\s+left|limited|begrenzt|limitad'), 'дефицит'],
  [word('терап|therap|terap'), 'терапия'],
  [word('лечеб|лікув|heal|heil|cura(?!\\p{L})|curar'), 'лечение'],
  [whole('(сон|сна|сну|сном)'), 'сон'],
  [word('засыпа|засина|sleep|schlaf|sueño|dormir'), 'сон'],
  [word('развити[ея] речи|розвит|мовленн|speech development|sprachentwicklung|desarrollo del habla'), 'развитие речи'],
  [word('полностью приват|повністю приват|fully private|vollständig privat|completamente privad|totalmente privad'), '«полностью приватно»'],
  [word('войн|воен|фронт|погиб|утрат|втрат|war(?!\\p{L})|military|krieg|guerra|militar'), 'военная лексика / страх потери'],
  [word('навсегда|назавжди|forever|für immer|para siempre'), '«навсегда» (обещание сохранить привязанность)'],
  [word('отзывы|оценка|бестселлер|хит продаж|№'), 'социальное доказательство'],
];
for (const [locale, list] of strings) {
  for (const [at, value] of list) {
    // Имя платформы содержит цифру — это марка, а не число.
    const text = value.replace(/viral4creators/g, 'viralcreators');
    for (const [re, why] of FORBIDDEN) {
      assert.ok(!re.test(text), `${locale} ${at}: запрещено (${why}): «${value}»`);
    }
  }
}

// «На службе» — один раз на локаль, как пример дистанции (§3), не тема.
const duty: Record<string, RegExp> = {
  ru: /на службе/iu,
  uk: /на службі/iu,
  en: /on duty/iu,
  de: /im Dienst/iu,
  es: /de servicio/iu,
};
for (const [locale, list] of strings) {
  const count = list.filter(([, v]) => duty[locale].test(v)).length;
  assert.equal(count, 1, `${locale}: пример «на службе» встречается ${count} раз`);
}

// ── 4. Марка ───────────────────────────────────────────────────────────
assert.equal(BRAND, 'Story‑Tales');
for (const [locale, list] of strings) {
  for (const [at, value] of list) {
    assert.doesNotMatch(value, /Story-Tales|Story Tales/u, `${locale} ${at}: марка без неразрывного дефиса`);
  }
}

console.log(
  `stories-copy: ${locales.length} локалей одной формы (${strings.get('ru')!.length} строк в каждой), тексты ТЗ дословно, десять вопросов FAQ, запреты текста проверены`,
);
