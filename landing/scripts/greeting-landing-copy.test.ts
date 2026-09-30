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
 *     «перегенерация ничего не стоит» (рендер упирается в суточный лимит).
 *  4. Режим «Я в кадре» (этап J): его тексты живут ТОЛЬКО в разделе
 *     `greetingsLanding.persona` — секция «Вы в кадре» и дополнения
 *     «Лицо» / «Голос» к «Данным», обе за `PERSONA_SECTION_ENABLED`.
 *     Во всём остальном разделе — ни слова о режиме: остальное выводится
 *     на страницу всегда, и упоминание там обошло бы выключатель. А сами
 *     тексты режима не обещают того, чего код не делает: «личность
 *     подтверждена», «цифровой двойник», «то же лицо в каждом кадре»,
 *     маркировку ИИ-контента (В-6 не решён); и называют числа, которые
 *     есть в коде бэкенда, — сверяются с его константами.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
];

/**
 * Словарь режима «Я в кадре». Вне `greetingsLanding.persona` запрещён:
 * всё остальное страница выводит без выключателя. Кириллица — без `\b`:
 * в JS без флага `u` граница слова знает только латиницу.
 */
const PERSONA_WORDS =
  /в кадре сами|я в кадре|вы в кадре|я в кадрі|ви в кадрі|you in the frame|me on screen|you on screen|ich im bild|sie im bild|yo en pantalla|tú en pantalla|tú en (el )?(video|cuadro)|селфи|селфі|selfie|аватар|avatar|своим лицом|своїм обличчям|your own face|ihr eigenes gesicht|tu propia cara|клон|clone|klon|clon de voz|liveness|живост|живіст|скетч|sketch|skizze|boceto|бренд-бук|brand.?book|(^|[^а-яёіїє])образ/i;

/** Тексты режима не обещают того, чего в коде нет (§4, Т-16, AI-ACTORS). */
const PERSONA_UNTRUE: Array<[RegExp, string]> = [
  [
    /личност\S* (подтвержд|провер\S* и подтвержд)|подтвержд\S* личност|особ\S* підтвердж|підтвердж\S* особ|identity (is |was |has been )?(verified|confirmed)|verified identity|verify your identity|identität\S* (bestätigt|verifiziert)|identidad (verificada|confirmada)/i,
    '«личность подтверждена» — живость проверяет модель, это не проверка личности (Т-16)',
  ],
  [
    /двойник|двійник|twin|zwilling|gemelo|doble digital/i,
    '«цифровой двойник» — режим на референс-изображениях, обученной модели лица нет (строка AI-ACTORS в ТЗ)',
  ],
  [
    /в каждом кадре|в кожному кадрі|in every (frame|shot|scene)|in jedem (bild|frame|video)|en cada (fotograma|plano|cuadro|escena)|same face|то же лицо|те саме обличчя|dasselbe gesicht|la misma cara/i,
    '«то же лицо в каждом кадре» — сходство близкое, но не гарантировано',
  ],
  [
    /маркир|маркув|помет(к|ен)|помічен|водян\S* знак|label|kennzeichn|wasserzeichen|etiquet|marca de agua|watermark/i,
    'обещание маркировки ИИ-контента — В-6 не решён (TBD, решает юрист в шлюзе §4.10)',
  ],
];

/**
 * Завышенные обещания, найденные аудитом этапа J (исправлены в текстах,
 * здесь — чтобы не вернулись):
 *  - «только камерой / не из галереи» — это свойство экрана приложения,
 *    а не гарантия: говорим «выбора из галереи в приложении нет»;
 *  - «удалить всё» — из НАШЕГО хранилища; копии у видеосервисов и кеш
 *    CDN вне нашей власти (`persona.service.ts` `erase`, отчёт этапа G);
 *  - «передаются только ИИ-сервисам» — готовые образы получают и
 *    видеосервисы (xAI, Hedra), источники — только Gemini;
 *  - «клон только из записи с фразой» — фраза согласия не распознаётся
 *    (отступление этапа F), это не проверка;
 *  - «голос звучит в роликах, где вы в кадре» — голос персоны допустим и
 *    как голос отправителя без образа (`PERSONA_VOICE_ONLY_PERSONAL`).
 */
PERSONA_UNTRUE.push(
  [
    /только камерой|лише камерою|camera only|nur mit der kamera|solo con la cámara|не из галереи|не з галереї|not from the gallery|nicht aus der galerie|no desde la galería/i,
    '«только камерой, не из галереи» — честно: «в приложении нет выбора из галереи»',
  ],
  [
    /удалить всё|удаляет всё|видалити все|delete everything|alles löschen|borrarlo todo/i,
    '«удалить всё» — удаляется из нашего хранилища; копии у видеосервисов и кеш остаются',
  ],
  [
    /передаются только|передаються лише|go only to|gehen nur an|solo se envían a los servicios/i,
    '«передаются только ИИ-сервисам» — образы получают и видеосервисы (xAI, Hedra)',
  ],
  [
    /только из вашей записи|лише з вашого запису|only from your own recording|nur aus ihrer eigenen aufnahme|solo a partir de tu propia grabación/i,
    '«только из записи с фразой согласия» — фраза не распознаётся, это не гарантия',
  ],
  [
    /(голос|voice|stimme|voz)[^.]*(где вы в кадре|де ви в кадрі|where you are on screen|in denen sie im bild sind|en los que sales en pantalla)/i,
    '«голос звучит там, где вы в кадре» — голос персоны бывает и голосом отправителя без образа',
  ],
);

/** Срок хранения источников — число в контексте срока, а не любое «30». */
function retentionPhrase(locale: string, days: number): RegExp {
  const byLocale: Record<string, string> = {
    ru: `${days} дней после`,
    uk: `${days} днів після`,
    en: `${days} days after`,
    de: `${days} Tage nach`,
    es: `${days} días después`,
  };
  return new RegExp(byLocale[locale]);
}

/** «Это защита от чужого фото, а не проверка личности» — обязательна. */
const NOT_IDENTITY_CHECK: Record<string, RegExp> = {
  ru: /а не проверка личности/,
  uk: /а не перевірка особи/,
  en: /not an identity check/,
  de: /keine Identitätsprüfung/,
  es: /no es una comprobación de identidad/,
};

/** Константы бэкенда, которые тексты называют числами. */
const backend = (rel: string) =>
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'backend', 'src', ...rel.split('/')),
    'utf8',
  );
function constOf(src: string, name: string): number {
  const m = new RegExp(`export const ${name} = (\\d+);`).exec(src);
  assert.ok(m, `в коде бэкенда не нашлась константа ${name}`);
  return Number(m[1]);
}
const MIN_AGE = constOf(
  backend('modules/persona/persona-rules.ts'),
  'PERSONA_MIN_AGE',
);
const RETENTION_DAYS = constOf(
  backend('modules/persona/persona-consent.ts'),
  'PERSONA_SOURCES_RETENTION_DAYS',
);
const looksRules = backend('modules/persona/persona-looks.rules.ts');
const LOOK_AGE_MIN = constOf(looksRules, 'LOOK_AGE_MIN');
const LOOK_AGE_MAX = constOf(looksRules, 'LOOK_AGE_MAX');
// Голос персоны — тот же тарифный признак, что обычный клон (В-1):
// `voiceCloning` закрыт на LITE, значит «Standard и выше».
assert.match(
  backend('modules/user-voices/user-voices.service.ts'),
  /assertUser\(userId, 'voiceCloning'\)/,
  'голос персоны больше не за voiceCloning — «Standard и выше» в текстах могло стать неправдой',
);
assert.match(
  backend('common/plans.ts'),
  /LITE: \{[\s\S]*?voiceCloning: false,[\s\S]*?STANDARD: \{/,
  'voiceCloning больше не закрыт на LITE — поправьте «Standard и выше» в текстах',
);

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

  // ── Режим «Я в кадре»: тексты только в своём разделе ──
  const { persona, ...outside } = g;
  const personaTexts = strings(persona);
  for (const text of strings(outside)) {
    assert.doesNotMatch(
      text,
      PERSONA_WORDS,
      `${locale}: упоминание режима «Я в кадре» вне greetingsLanding.persona — выводится без выключателя PERSONA_SECTION_ENABLED\n  «${text}»`,
    );
    // Короткие заголовки («Голос», «Лицо») — обычные слова; копией
    // считается фраза, а не слово.
    for (const own of personaTexts.filter((t) => t.length >= 40)) {
      assert.ok(
        !text.includes(own),
        `${locale}: текст раздела persona скопирован в другую секцию\n  «${own}»`,
      );
    }
  }
  assert.equal(persona.steps.length, 4, `${locale}: шагов «Вы в кадре» не 4`);
  assert.equal(
    persona.privacy.length,
    2,
    `${locale}: дополнений к «Данным» два — лицо и голос`,
  );
  for (const text of personaTexts) {
    for (const [re, why] of PERSONA_UNTRUE) {
      assert.doesNotMatch(text, re, `${locale}: ${why}\n  «${text}»`);
    }
  }
  const all = personaTexts.join('\n');
  assert.match(
    all,
    NOT_IDENTITY_CHECK[locale],
    `${locale}: нет оговорки «защита от чужого фото, а не проверка личности» (Т-16)`,
  );
  for (const [n, what] of [
    [MIN_AGE, 'порог допуска PERSONA_MIN_AGE'],
    [LOOK_AGE_MIN, 'нижняя граница возраста образа'],
    [LOOK_AGE_MAX, 'верхняя граница возраста образа'],
  ] as const) {
    assert.ok(
      new RegExp(`(^|\\D)${n}(\\D|$)`).test(all),
      `${locale}: тексты «Вы в кадре» не называют ${n} — ${what} в коде бэкенда`,
    );
  }
  assert.match(all, /Standard/, `${locale}: голос — «Standard и выше»`);
  assert.match(
    strings(persona.privacy).join('\n'),
    retentionPhrase(locale, RETENTION_DAYS),
    `${locale}: «Лицо» не называет срок «${RETENTION_DAYS} дней после последнего образа» — PERSONA_SOURCES_RETENTION_DAYS в коде бэкенда`,
  );
}

console.log(
  `greeting-landing-copy: ok (${locales.length} локалей одной формы; ` +
    `кадров ${GREETING_FRAME_COUNT}; запрещённых формулировок нет; ` +
    `тексты «Вы в кадре» только в своём разделе)`,
);
