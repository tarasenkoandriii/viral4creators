/**
 * Тексты страницы поздравлений (`greetingsLanding`) — этап H ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §5.4, §8.4.
 *
 * Три вещи, которые типы не ловят:
 *
 *  1. Форма раздела одна во всех пяти локалях — не только ключи (их
 *     держит тип `Dictionary`, построенный по русскому файлу), но и ДЛИНЫ
 *     списков: лишний пункт FAQ в немецком тип пропустит.
 *  2. «Как это работает»: пунктов ровно `GREETING_FRAME_COUNT`, и обе
 *     оговорки — «это схемы» и «это настоящие кадры» — есть и различны.
 *  3. Фразы, которые сверка с кодом признала неправдой, не возвращаются:
 *     «без регистрации» (проекты закрыты `TelegramIdentityGuard`),
 *     «перегенерация ничего не стоит» (рендер упирается в суточный лимит),
 *     и ни слова о режиме «Я в кадре», пока он за `PERSONA_ENABLED`.
 */
import assert from 'node:assert/strict';
import { getDictionary } from '../src/lib/get-dictionary';
import { locales } from '../src/lib/i18n';
import { GREETING_FRAME_COUNT } from '../src/lib/greeting-frames';

type Json = unknown;

/** Форма значения: строки → 's', массивы — с длиной и формой элементов. */
function shape(v: Json): Json {
  if (typeof v === 'string') return 's';
  if (Array.isArray(v)) return v.map(shape);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, shape((v as Record<string, Json>)[k])]),
    );
  }
  return typeof v;
}

const ru = getDictionary('ru').greetingsLanding;
const reference = shape(ru);

/** Каждая строка раздела — для поиска запрещённых фраз. */
function strings(v: Json): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === 'object')
    return Object.values(v as object).flatMap(strings);
  return [];
}

/**
 * Неправда по коду, по локалям. `steps` из поиска исключён: он на
 * странице не выводится (источник тем консультанта), но и там таких
 * фраз нет — проверяется отдельно ниже целиком.
 */
const FORBIDDEN: Array<[RegExp, string]> = [
  [
    /без регистрации|без реєстрації|no sign-up|ohne Registrierung|sin registro(?! aparte)/i,
    '«без регистрации» — неправда: мастер требует входа через Telegram',
  ],
  [
    /ничего не стоит|нічого не коштує|costs nothing|kostet also nichts|no cuesta nada/i,
    '«ничего не стоит» — неправда: каждая попытка идёт в суточный лимит',
  ],
  [
    /оплаты нет|оплати немає|no payment|keine Bezahlung|no hay pagos/i,
    '«оплаты нет» — неправда: пакеты генераций покупаются независимо от PLANS_BILLING_ENABLED; честно — «режимы сейчас бесплатны»',
  ],
  [
    /в кадре сами|вы в кадре|ви в кадрі|you in the frame|sie im bild|tú en (el )?(video|cuadro)|селфи|selfie|аватар|avatar|своим лицом|своїм обличчям|your own face|ihr eigenes gesicht|tu propia cara/i,
    'упоминание режима «Я в кадре» — он за выключенным PERSONA_ENABLED',
  ],
];

for (const locale of locales) {
  const g = getDictionary(locale).greetingsLanding;
  assert.deepEqual(
    shape(g),
    reference,
    `${locale}: форма greetingsLanding разошлась с ru`,
  );

  assert.equal(
    g.how.items.length,
    GREETING_FRAME_COUNT,
    `${locale}: пунктов «Как это работает» ${g.how.items.length}, кадров ${GREETING_FRAME_COUNT}`,
  );
  for (const key of ['title', 'lead', 'leadReal', 'shotAlt'] as const) {
    assert.ok(g.how[key].trim(), `${locale}: how.${key} пустой`);
  }
  assert.notEqual(
    g.how.lead,
    g.how.leadReal,
    `${locale}: оговорки «схемы» и «настоящие кадры» совпадают`,
  );

  // Наклейка существует только при ключе PIXABAY_API_KEY: без него
  // карточки в мастере нет вовсе (`StickerStep`, `stickerCardHidden`).
  // Поэтому в том, что страница ОБЕЩАЕТ (кадры и возможности), наклейки
  // нет; упоминать её как недоступную для деликатных поводов — можно.
  for (const text of strings([g.how, g.features])) {
    assert.doesNotMatch(
      text,
      /наклейк|наліпк|sticker/i,
      `${locale}: обещание наклейки, которой без PIXABAY_API_KEY нет\n  «${text}»`,
    );
  }

  // Четыре пункта `steps` читает сборщик базы консультанта — они остаются.
  assert.equal(
    g.steps.items.length,
    4,
    `${locale}: steps.items нужен build-assistant-knowledge.ts ровно из 4 пунктов`,
  );

  assert.equal(
    g.audience.items.length,
    4,
    `${locale}: «Для кого» — семья, друзья, коллеги и HR, деликатные`,
  );
  assert.ok(g.privacy.items.length > 0);

  for (const text of strings(g)) {
    assert.ok(
      text.trim().length > 0,
      `${locale}: пустая строка в greetingsLanding`,
    );
    for (const [re, why] of FORBIDDEN) {
      assert.doesNotMatch(text, re, `${locale}: ${why}\n  «${text}»`);
    }
  }
}

console.log(
  `greeting-landing-copy: ok (${locales.length} локалей одной формы; ` +
    `кадров ${GREETING_FRAME_COUNT}; запрещённых формулировок нет)`,
);
