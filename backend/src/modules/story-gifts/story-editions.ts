import { createHash } from 'node:crypto';
/**
 * Story‑Tales editorial registry (spec §23.5, TODO 9949/9952).
 *
 * Source of truth for every text the wizard may narrate. It lives in code on
 * purpose (Р-ST-WP2-1): texts and their SHA-256 are immutable once a gift or a
 * video master references them, every change goes through git review, and the
 * integrity spec (story-editions.spec.ts) fails if a text, a hash, a rights
 * record or an adaptation link drifts. Scans are never stored here — only the
 * public URL of the scan/edition and, when it was recorded, the scan SHA-256.
 *
 * Changing a published text = a NEW edition id (old id → `retired`), never an
 * in-place edit: rendered gifts and STORY_VIDEO_BASE pin `textSha256`.
 */
export type StoryEditionKind = 'classic' | 'adaptation' | 'original';
export type StoryLegalStatus = 'public_domain' | 'licensed' | 'own' | 'unknown';
export type StoryEditionStatus = 'candidate' | 'approved' | 'retired';
export interface StoryChapter {
  title: string;
  scene: string;
  text: string;
}
export interface StoryEdition {
  id: string;
  kind: StoryEditionKind;
  /** Language of the narrated text — not the user's country or origin. */
  locale: string;
  /** Countries where the wizard recommends it first (empty = by language only). */
  countries: string[];
  title: string;
  revision: string;
  ageBand: string;
  targetSeconds: number;
  /** Short human summary of rights, shown as `rights` in the catalogue. */
  rightsSummary: string;
  /** Author of the literal text (writer, folklore editor or platform). */
  author: string | null;
  translator: string | null;
  /** Printed edition the literal text was verified against (classic only). */
  publication: {
    citation: string;
    book: string;
    volume: string | null;
    year: number | null;
    pages: string | null;
    publisher: string | null;
  } | null;
  source: {
    /** Where the literal text was taken from (scan/edition). */
    textUrl: string | null;
    /** Where the plot comes from — differs from textUrl for adaptations. */
    plotUrl: string | null;
    /** Link to the scan; the scan itself is never committed. */
    scanUrl: string | null;
    /** SHA-256 of the scan file, only when actually recorded by the editor. */
    scanSha256: string | null;
    scanLocation: string | null;
  };
  legal: {
    status: StoryLegalStatus;
    basis: string;
    /** YYYY-MM-DD of the last rights review. */
    checkedAt: string;
  };
  responsible: string;
  status: StoryEditionStatus;
  /** Visual comparison with the scan (classic) — what was normalized. */
  textVerification: { verifiedAt: string; normalization: string } | null;
  /** SHA-256 of chapter texts joined by a blank line; checked against the text. */
  textSha256: string;
  adaptation: {
    /** Registered classic edition this adaptation departs from, if any. */
    classicEditionId: string | null;
    plotSourceTitle: string;
    plotSourceUrl: string;
    /** Every deliberate difference from the source, shown before synthesis. */
    changes: string[];
  } | null;
  chapters: readonly StoryChapter[];
}

const OWNER = 'Владелец Story‑Tales (закрытая разработка)';
const mittenSource =
  'https://uk.wikisource.org/wiki/Народныя_южнорусскія_сказки/2/1';
/** Rudchenko vol. 1–2 (1869–1870), one Google Books PDF on Commons (464 pp.). */
const rudchenkoScan =
  'https://upload.wikimedia.org/wikipedia/commons/a/ae/Народныя_южнорусскія_сказки._Рудченко_(1869).pdf';
const mittenPlot =
  '«Рукавичка», «Народныя южнорусскія сказки», вып. 2 (изд. И. Рудченко, Киев, 1870)';
const MITTEN_CLASSIC = 'mitten-rudchenko-uk-1870-v1';
const frankoTurnipText = 'https://uk.wikisource.org/wiki/Ріпка_(1918)';
const frankoTurnipScan =
  'https://upload.wikimedia.org/wikipedia/commons/e/e0/Іван_Франко._Ріпка_(1918).djvu';
const pigsSource =
  'https://en.wikisource.org/wiki/English_Fairy_Tales/The_Story_of_the_Three_Little_Pigs';
const shortRights =
  'Короткий авторский пересказ народного сюжета. Мягкий финал; не текст современного издания.';
const ownRetelling = (plot: string) => ({
  status: 'own' as const,
  basis: `Собственный текст платформы: короткий пересказ сюжета (${plot}), находящегося в общественном достоянии. Современные переводы, иллюстрации и издания не копировались.`,
  checkedAt: '2026-10-16',
});
// Р-ST3-CONTENT-5: differences re-checked against the scan of the classic
// (Rudchenko 1870, vol. 2, pp. 1–2) and Jacobs 1890 on 2026-10-20.
const mittenChanges = (language: string) => [
  `Собственный короткий пересказ на ${language}, а не текст сборника И. Рудченко (вып. 2, 1870); классическая редакция — ${MITTEN_CLASSIC}.`,
  'Сокращено до трёх сцен (ориентир 35 с чтения); опущены повторяющиеся вопросы «Хто, хто у цій рукавицці?» и прозвища зверей (мишка-скряботушка, жабка-скрекотушка, зайчик-лапанчик, лисичка-сестричка).',
  'В рукавичку попадают только мышка, лягушка (жабка), зайчик и лисичка; волк (вовчик-братік), медведь (ведмідь-набрідь) и кабан (кабан-неклан) из источника опущены.',
  'Изменён финал: в источнике стрелец стреляет в шевелящуюся рукавичку и звери гибнут; в пересказе возвращается дедушка с собакой, собака лает и звери убегают невредимыми. Дедушки с собакой в финале источника нет.',
  'Добавлены лес как место действия, мотив «пустили соседей погреться» и итоговая фраза о заботе друг о друге — новая мораль, которой нет в источнике.',
];
const pigsChanges = (language: string) => [
  `Собственный короткий пересказ на ${language}, а не текст сборника Джозефа Джекобса (English Fairy Tales, 1890).`,
  'Материалы домов: в источнике солома, утёсник (furze) и кирпич; в пересказе солома, ветки и кирпич.',
  'В источнике волк съедает двух поросят; в пересказе они убегают к брату в кирпичный дом.',
  'Опущены эпизоды с репой, яблоками и ярмаркой; в источнике волк падает в котёл и третий поросёнок съедает его, в пересказе волк не погибает, а уходит сам.',
  'Добавлена итоговая фраза о терпеливой работе и помощи друг другу — новая мораль.',
];

export const STORY_EDITIONS: readonly StoryEdition[] = [
  {
    id: 'turnip-ushinsky-ru-1949-v1',
    kind: 'classic',
    locale: 'ru',
    countries: ['UA', 'OTHER', 'GB', 'US', 'DE', 'ES'],
    title: 'Репка',
    revision: 'ushinsky-t6-1949-pages45-46-v1',
    ageBand: '3–7',
    targetSeconds: 65,
    rightsSummary:
      'Народная сказка в обработке К. Д. Ушинского (1824–1871). Точный текст по изданию 1949 года, с. 45–46; без сокращений и новой морали. Используется текст автора в общественном достоянии, без редакционных комментариев и иллюстраций издания.',
    author: 'Константин Дмитриевич Ушинский',
    translator: null,
    publication: {
      citation:
        'Собрание сочинений. Том 6. Родное слово. Москва — Ленинград: Издательство АПН РСФСР, 1949',
      book: 'Собрание сочинений. Родное слово',
      volume: '6',
      year: 1949,
      pages: '45–46 (PDF 46–47)',
      publisher: 'Москва — Ленинград: Издательство АПН РСФСР',
    },
    source: {
      textUrl:
        'https://imwerden.de/pdf/ushinsky_sobranie_sochineny_tom06_1949_text.pdf#page=46',
      plotUrl: null,
      scanUrl:
        'https://imwerden.de/pdf/ushinsky_sobranie_sochineny_tom06_1949_text.pdf#page=46',
      // Р-ST3-CONTENT-1: the very file of scanUrl, fetched 2026-10-20.
      scanSha256:
        '6bca60042f73e16eadf1de2bd969096fae49e899f2f84fb6b9d492f942b4fa57',
      scanLocation:
        'Внешняя ссылка imwerden.de (файл ushinsky_sobranie_sochineny_tom06_1949_text.pdf, 11 616 148 байт, 449 стр. PDF, Last-Modified 27.12.2022, ETag "63ab8532-b13f94"; скачан 20.10.2026, SHA-256 по всему файлу). Печатные с. 45–46 = PDF 46–47. Копия скана в репозитории не хранится.',
    },
    legal: {
      status: 'public_domain',
      basis:
        'Обработка народной сказки К. Д. Ушинского (ум. 1871) — общественное достояние. Иллюстрации и редакционные комментарии издания 1949 года не используются.',
      checkedAt: '2026-10-16',
    },
    responsible: OWNER,
    status: 'approved',
    textVerification: {
      verifiedAt: '2026-10-16',
      normalization:
        'Убраны переносы строк/слов и типографские пробелы; текст, имя кошки Машка и финал сохранены. Заголовки трёх сцен — навигация, не озвучиваются.',
    },
    textSha256:
      '39207ca8c60f88adf5cc9085cf2677fb82dd6da3c7ad41715ea17f7bf3cdaeb7',
    adaptation: null,
    chapters: [
      {
        title: 'Большая репка',
        scene: 'turnip',
        text: 'Посадил дед репку — выросла большая, пребольшая. Стал дед репку из земли тащить: тянет-потянет, вытянуть не может. Позвал дед на помощь бабку. Бабка за дедку, дедка за репку: тянут-потянут, вытянуть не могут.',
      },
      {
        title: 'Все на помощь',
        scene: 'turnip',
        text: 'Позвала бабка внучку. Внучка за бабку, бабка за дедку, дедка за репку: тянут-потянут, вытянуть не могут. Кликнула внучка Жучку. Жучка за внучку, внучка за бабку, бабка за дедку, дедка за репку: тянут-потянут, вытянуть не могут. Кликнула Жучка Машку. Машка за Жучку, Жучка за внучку, внучка за бабку, бабка за дедку, дедка за репку: тянут-потянут, вытянуть не могут.',
      },
      {
        title: 'Мышка помогла',
        scene: 'turnip',
        text: 'Кликнула Машка мышку. Мышка за Машку, Машка за Жучку, Жучка за внучку, внучка за бабку, бабка за дедку, дедка за репку: тянут-потянут — вытащили репку!',
      },
    ],
  },
  {
    id: 'little-lantern-ru-v1',
    kind: 'original',
    locale: 'ru',
    countries: [],
    title: 'Фонарик для звезды',
    revision: '1',
    ageBand: '4–8',
    targetSeconds: 180,
    rightsSummary:
      'Оригинальный текст платформы, редакция 1. Не адаптация стороннего издания.',
    author: 'Story‑Tales (текст платформы)',
    translator: null,
    publication: null,
    source: {
      textUrl: null,
      plotUrl: null,
      scanUrl: null,
      scanSha256: null,
      scanLocation: null,
    },
    legal: {
      status: 'own',
      basis:
        'Оригинальный текст платформы; сторонние издания не использовались.',
      checkedAt: '2026-10-16',
    },
    responsible: OWNER,
    status: 'approved',
    textVerification: null,
    textSha256:
      'b5e81549e1c2708fe7ba469e8d2dc338e64862d9ec052bf6017637d2c0f1d5f5',
    adaptation: null,
    chapters: [
      {
        title: 'Тихий вечер',
        scene: 'forest',
        text: 'На краю леса стоял маленький домик. В нём жил лисёнок Тим. Каждый вечер он зажигал фонарик и ставил его на подоконник. Свет был тёплым, как чашка чая, и круглым, как маленькое солнце. Однажды Тим заметил: над большой сосной не видно звезды. Обычно она появлялась первой. Лисёнок открыл окно и тихонько позвал её. В ответ зашуршала только трава. Тогда он надел шарф, взял фонарик и вышел на тропинку. Спешить было некуда. Лес готовился ко сну, а Тим умел ходить очень тихо.',
      },
      {
        title: 'Свет на тропинке',
        scene: 'bridge',
        text: 'У ручья сидел ёжик и рассматривал мостик. Между досками лежала шишка, и пройти с корзинкой было неудобно. Тим поставил фонарик рядом. Теперь ёжик хорошо видел дорожку. Вместе они убрали шишку и перешли ручей. За мостиком нашлась варежка бельчонка. Тим поднял её, а ёжик позвал хозяина. Бельчонок прибежал, обрадовался и показал друзьям короткую дорогу к холму. Фонарик покачивался в лапе лисёнка. Его свет не доставал до неба, зато освещал всё, что было рядом: гладкие камушки, жёлтые листья и маленькие следы на песке.',
      },
      {
        title: 'Звезда нашлась',
        scene: 'stars',
        text: 'На вершине холма друзья остановились. Над сосной плыла пушистая тучка. Вот она сдвинулась, и из-за неё выглянула знакомая звезда. Никто её не потерял: она просто была за облаком. Тим поднял фонарик и помахал свободной лапой. Звезда мерцала, будто тоже отвечала ему. Друзья немного посидели вместе, слушая вечерний лес, а потом отправились домой. У двери Тим погасил фонарик. Сегодня его маленький свет помог ёжику пройти мостик, а бельчонку найти варежку. Этого было вполне достаточно. Лисёнок укрылся одеялом и посмотрел в окно. Звезда была на месте. Лес тихо дышал. Наступила спокойная ночь.',
      },
    ],
  },
  {
    id: 'mitten-ru-short-v1',
    kind: 'adaptation',
    locale: 'ru',
    countries: ['UA'],
    title: 'Рукавичка',
    revision: '1-short',
    ageBand: '3–7',
    targetSeconds: 35,
    rightsSummary: shortRights,
    author: 'Story‑Tales (пересказ)',
    translator: null,
    publication: null,
    source: {
      textUrl: null,
      plotUrl: mittenSource,
      scanUrl: null,
      scanSha256: null,
      scanLocation: null,
    },
    legal: ownRetelling(mittenPlot),
    responsible: OWNER,
    status: 'approved',
    textVerification: null,
    textSha256:
      '4cda9202310b4d148adb7c36b9d4b19b11c1fb49f27716dc6bcf508eb0e81ba1',
    adaptation: {
      classicEditionId: MITTEN_CLASSIC,
      plotSourceTitle: mittenPlot,
      plotSourceUrl: mittenSource,
      changes: mittenChanges('русском языке'),
    },
    chapters: [
      {
        title: 'На лесной тропинке',
        scene: 'mitten',
        text: 'Однажды дедушка потерял в лесу рукавичку. Мышка нашла её и устроилась внутри.',
      },
      {
        title: 'Тёплый домик',
        scene: 'mitten',
        text: 'Потом попросились лягушка, зайчик и лисичка. Звери подвинулись и пустили соседей погреться.',
      },
      {
        title: 'Пора домой',
        scene: 'mitten',
        text: 'Но тут вернулся дедушка с собакой. Собака гавкнула, гости разбежались, а дедушка поднял рукавичку. Всем нашлось место, пока каждый заботился о других.',
      },
    ],
  },
  // Р-ST3-CONTENT-2: first UK classic. Text = the 4th edition (Kyiv, 1918),
  // compared page by page with the DjVu scan on 2026-10-20
  // (doc/reports/story-editions-2026-10-20.md). Approved 20.10.2026 (ST3);
  // placed before the UK adaptation: the wizard offers it first for UA/uk.
  {
    id: 'turnip-franko-uk-1918-v1',
    kind: 'classic',
    locale: 'uk',
    countries: ['UA'],
    title: 'Ріпка',
    revision: 'franko-1918-ed4-pages3-14-v1',
    ageBand: '3–7',
    targetSeconds: 170,
    rightsSummary:
      'Казка Івана Франка (1856–1916). Точный текст по 4-му изданию (Киев, 1918), с. 3–14; без сокращений и новой морали. Иллюстрации Г. Павловича и оформление издания не используются.',
    author: 'Іван Якович Франко',
    translator: null,
    publication: {
      citation:
        'Іван Франко. Ріпка. Казка з малюнками Г. Павловича. Видання четверте. Київ: Друкарня Київської Народньої Управи, 1918',
      book: 'Ріпка',
      volume: null,
      year: 1918,
      pages: '3–14 (DjVu 3–14)',
      publisher: 'Київ: Друкарня Київської Народньої Управи',
    },
    source: {
      textUrl: frankoTurnipText,
      plotUrl: null,
      scanUrl: frankoTurnipScan,
      scanSha256:
        '10d3abbbc68f1fb756f8e2486a4c2483ac7916828ae0d6a207c6183f29df3ae8',
      scanLocation:
        'Wikimedia Commons, файл «Іван Франко. Ріпка (1918).djvu» (132 263 байт, 15 стр. 974×773 px, SHA-1 438ba4faca747cda0774b659d6e46657af1daca0 совпал с Commons; источник скана по описанию — электронная библиотека НБУ для детей, chl.kiev.ua/elibrary/Book/Show/177). Скачан 20.10.2026. Копия в репозитории не хранится.',
    },
    legal: {
      status: 'public_domain',
      basis:
        'Текст Ивана Франко (ум. 1916, 28 мая): срок охраны «жизнь + 70 лет» истёк 01.01.1987 — общественное достояние в UA (Закон Украины «Об авторском праве и смежных правах») и EU (Директива 2006/116/ЕС). Прижизненных переводчиков нет. Иллюстрации Г. Павловича (год смерти не установлен) и оформление издания не используются.',
      checkedAt: '2026-10-20',
    },
    responsible: OWNER,
    status: 'approved',
    textVerification: {
      verifiedAt: '2026-10-20',
      normalization:
        'Сверено постранично со сканом (с. 3–14) и с выверенной (уровень 4) транскрипцией uk.wikisource. Орфография и пунктуация издания сохранены, включая «Що-день», «Взяв»/«Узяв» и «поможи“!». Нормализовано: переносы строк и слов, абзацы внутри сцены слиты пробелом, тире с пробелами, одна закрывающая кавычка ” приведена к “. Разрешение скана не позволяет уверенно отличить «г» от «ґ» (у «г» в шрифте издания есть засечка) — принято чтение «г» выверенной транскрипции. Заголовки трёх сцен — навигация, не озвучиваются.',
    },
    textSha256:
      '65f84f9b1b5ee928a283cc522648d90cbea79ba6be9b1d72641212da220fc579',
    adaptation: null,
    chapters: [
      {
        title: 'Дідова ріпка',
        scene: 'turnip',
        text: 'Був собі дід Андрушка, а в нього баба Марушка, а в баби дочечка Мінка, а в дочки собачка Хвінка, а в собачки товаришка киця Варварка, а в киці годованка мишка Сіроманка. Раз весною взяв дід рискаль та мотику, скопав у городі грядку велику, гноєм трохи попринадив, грабельками підгромадив, зробив пальцем дірку та й посадив ріпку. Працював дід не марно: зійшла ріпка гарно. Що-день ішов дід у город, набравши води повен рот, свою ріпку підливав, їй до життя охоти додавав. Росла дідова ріпка, росла! Зразу така, як мишка була, потому, як кулак, потому, як буряк, потому як два, а на кінці стала така, як дідова голова.',
      },
      {
        title: 'Дід, баба й дочка',
        scene: 'turnip',
        text: 'Тішиться дід, аж не знає, де стати. „Час, — каже, — нашу ріпку рвати!“ Пішов він у город — гуп, гуп! Узяв ріпку за зелений чуб; тягне руками, уперся ногами, добуває сил усіх, сопе, як ковальський міх; мучився-потів увесь день, а ріпка сидить у землі, як пень. Кличе дід бабу Марушку: „Ходи, бабусю, не лежи, мені ріпку вирвати поможи!“ Пішли вони в город — гуп, гуп! Взяв дід ріпку за чуб, баба діда за плече — тягнуть, аж піт тече! Смикає дід ріпку за чівку, смикає баба діда за обшивку, працюють руками, упіраються ногами; промучилися увесь день, а ріпка сидить у землі, як пень. Кличе баба дочку Мінку: „Ходи, доню, не біжи, нам ріпку вирвати поможи!“ Пішли вони у город — гуп, гуп! Узяв дід ріпку за чуб, баба діда за сорочку, дочка бабу за торочку; тягнуть руками, упіраються ногами; промучилися увесь день, а ріпка сидить у землі, як пень.',
      },
      {
        title: 'Усі разом',
        scene: 'turnip',
        text: 'Кличе дочка собачку Хвінку: „Ходи, Хвіночко, не біжи, нам ріпку вирвати поможи“! Пішли вони в город — гуп, гуп! Узяв дід ріпку за чуб, баба діда за обшивку, дочка бабу за запаску, собачка дочку за спідничку; промучилися увесь день, а ріпка сидить у землі, як пень. Кличе собачка кицю Варварку: „Ходи, Варварко, не лежи, нам ріпку вирвати поможи!“ Пішли вони в город — гуп, гуп! Узяв дід ріпку за чуб, баба діда за сорочку, дочка бабу за торочку, собачка дочку за спідничку, киця собачку за хвостик. Тягнуть і руками і зубами, упіраються ногами; промучилися увесь день, а ріпка сидить у землі, як пень. Кличе киця мишку Сіроманку: „Ходи, Сірочко, не біжи, нам ріпку вирвати поможи!“ Пішли вони в город — гуп, гуп! Узяв дід ріпку за чуб, баба діда за сорочку, дочка бабу за торочку, собачка дочку за спідничку, киця собачку за хвостик, мишка кицю за лапку — як потягли, як потягли, та й покотились.',
      },
    ],
  },
  {
    id: 'mitten-uk-short-v1',
    kind: 'adaptation',
    locale: 'uk',
    countries: ['UA'],
    title: 'Рукавичка',
    revision: '1-short',
    ageBand: '3–7',
    targetSeconds: 35,
    rightsSummary: shortRights,
    author: 'Story‑Tales (пересказ)',
    translator: null,
    publication: null,
    source: {
      textUrl: null,
      plotUrl: mittenSource,
      scanUrl: null,
      scanSha256: null,
      scanLocation: null,
    },
    legal: ownRetelling(mittenPlot),
    responsible: OWNER,
    status: 'approved',
    textVerification: null,
    textSha256:
      '64240f55bff95f59be433a58f092c75aa0df71d8878612fe6b389402cd25c0d1',
    adaptation: {
      classicEditionId: MITTEN_CLASSIC,
      plotSourceTitle: mittenPlot,
      plotSourceUrl: mittenSource,
      changes: mittenChanges('украинском языке'),
    },
    chapters: [
      {
        title: 'Лісова стежка',
        scene: 'mitten',
        text: 'Одного разу дідусь загубив у лісі рукавичку. Мишка знайшла її та вмостилася всередині.',
      },
      {
        title: 'Теплий будиночок',
        scene: 'mitten',
        text: 'Згодом попросилися жабка, зайчик і лисичка. Звірята посунулися та впустили сусідів погрітися.',
      },
      {
        title: 'Час додому',
        scene: 'mitten',
        text: 'Та ось повернувся дідусь із собакою. Собака загавкав, гості розбіглися, а дідусь підняв рукавичку. Усім знайшлося місце, доки кожен дбав про інших.',
      },
    ],
  },
  {
    id: 'three-pigs-en-short-v1',
    kind: 'adaptation',
    locale: 'en',
    countries: ['GB', 'US'],
    title: 'The Three Little Pigs',
    revision: '1-short',
    ageBand: '3–7',
    targetSeconds: 35,
    rightsSummary: shortRights,
    author: 'Story‑Tales (пересказ)',
    translator: null,
    publication: null,
    source: {
      textUrl: null,
      plotUrl: pigsSource,
      scanUrl: null,
      scanSha256: null,
      scanLocation: null,
    },
    legal: ownRetelling(
      'The Story of the Three Little Pigs, English Fairy Tales',
    ),
    responsible: OWNER,
    status: 'approved',
    textVerification: null,
    textSha256:
      '1279cc0c7957211c4fdd1cc7c509e59539f2c9c2c93b95162b20cd891c854609',
    adaptation: {
      classicEditionId: null,
      plotSourceTitle:
        'The Story of the Three Little Pigs, English Fairy Tales (J. Jacobs, 1890)',
      plotSourceUrl: pigsSource,
      changes: pigsChanges('английском языке'),
    },
    chapters: [
      {
        title: 'Three homes',
        scene: 'pigs',
        text: 'Three little pigs built homes from straw, sticks, and bricks.',
      },
      {
        title: 'A windy visitor',
        scene: 'pigs',
        text: 'A wolf blew down the first two houses. The little pigs hurried to their brother’s sturdy brick home.',
      },
      {
        title: 'Safe together',
        scene: 'pigs',
        text: 'The wolf huffed and puffed, but the brick house stayed firm. He gave up and left. Safe inside, the three brothers shared supper. Patient work and helping each other had made a good home.',
      },
    ],
  },
  {
    id: 'three-pigs-ru-short-v1',
    kind: 'adaptation',
    locale: 'ru',
    countries: ['GB', 'US', 'OTHER', 'DE', 'ES'],
    title: 'Три поросёнка',
    revision: '1-short',
    ageBand: '3–7',
    targetSeconds: 35,
    rightsSummary: shortRights,
    author: 'Story‑Tales (пересказ)',
    translator: null,
    publication: null,
    source: {
      textUrl: null,
      plotUrl: pigsSource,
      scanUrl: null,
      scanSha256: null,
      scanLocation: null,
    },
    legal: ownRetelling(
      'The Story of the Three Little Pigs, English Fairy Tales',
    ),
    responsible: OWNER,
    status: 'approved',
    textVerification: null,
    textSha256:
      '549e06fbfb9514a8753559e02a6e3f88b55d91827921da11b0e23cdaaee479ab',
    adaptation: {
      classicEditionId: null,
      plotSourceTitle:
        'The Story of the Three Little Pigs, English Fairy Tales (J. Jacobs, 1890)',
      plotSourceUrl: pigsSource,
      changes: pigsChanges('русском языке'),
    },
    chapters: [
      {
        title: 'Три домика',
        scene: 'pigs',
        text: 'Три поросёнка построили домики из соломы, веток и кирпича.',
      },
      {
        title: 'Нежданный гость',
        scene: 'pigs',
        text: 'Пришёл волк и сдул первые два домика. Поросята поспешили к брату в крепкий кирпичный дом.',
      },
      {
        title: 'Вместе надёжнее',
        scene: 'pigs',
        text: 'Волк дул и пыхтел, но дом устоял. Тогда он ушёл. Братья спокойно поужинали вместе. Они поняли: терпеливая работа и помощь друг другу делают дом надёжным.',
      },
    ],
  },
  // Р-ST3-CONTENT-3: the historical «Рукавичка» in the edition's own spelling.
  // Candidate: its ending (the hunter shoots, the animals die) needs an
  // explicit owner decision and a visible warning before it may be offered.
  {
    id: MITTEN_CLASSIC,
    kind: 'classic',
    locale: 'uk',
    countries: ['UA'],
    title: 'Рукавичка',
    revision: 'rudchenko-1870-vyp2-pages1-2-v1',
    ageBand: '6–8',
    targetSeconds: 100,
    rightsSummary:
      'Украинская народная сказка в записи А. Я. Рудченко (Миргород); «Народныя южнорусскія сказки», вып. 2, изд. И. Рудченко, Киев, 1870, с. 1–2. Точный текст в орфографии издания, без новой морали. Финал не смягчён: стрелец стреляет в рукавичку, и звери гибнут.',
    author:
      'Народная сказка; запись А. Я. Рудченко (Панас Мирный), издатель И. Я. Рудченко',
    translator: null,
    publication: {
      citation:
        'Народныя южнорусскія сказки. Выпускъ 2. Издалъ И. Рудченко. Кіевъ: Въ типографіи Е. Я. Федорова, 1870',
      book: 'Народныя южнорусскія сказки',
      volume: '2',
      year: 1870,
      pages: '1–2 (PDF 249–250)',
      publisher: 'Кіевъ: Въ типографіи Е. Я. Федорова',
    },
    source: {
      textUrl: mittenSource,
      plotUrl: null,
      scanUrl: rudchenkoScan,
      scanSha256:
        'bf83b1fd5bc548bb778ce9da2a31a86364f91a76b97a1a1a3a9ecfb1ea1ff8e9',
      scanLocation:
        'Wikimedia Commons, файл «Народныя южнорусскія сказки. Рудченко (1869).pdf» — оба выпуска (1869–1870) в одном PDF: 20 336 646 байт, 464 стр., SHA-1 71b70b48445af4a8aaaa157a50f357e44dd87c5b совпал с Commons; источник — Google Books LHgWAAAAYAAJ. Скачан 20.10.2026. Копия в репозитории не хранится.',
    },
    legal: {
      status: 'public_domain',
      basis:
        'Фольклорный текст; запись А. Я. Рудченко (Панас Мирный, ум. 1920) и издание И. Я. Рудченко (ум. 1905) — сроки «жизнь + 70 лет» истекли, общественное достояние в UA и EU. Скан — Google Books, на Commons с пометкой PD-old-70. Помета о записи и оформление издания не озвучиваются.',
      checkedAt: '2026-10-20',
    },
    responsible: OWNER,
    status: 'candidate',
    textVerification: {
      verifiedAt: '2026-10-20',
      normalization:
        'Сверено со сканом (PDF 249–250 = печатные с. 1–2 вып. 2) и с вычитанной транскрипцией uk.wikisource. Орфография издания сохранена (союз «и», «Иди», «питаєцця», «рукавицці»), не модернизировалась. Нормализовано: переносы («ворушиц-ця»), тире с пробелами, абзацы внутри сцены слиты пробелом. Исправлены две явные опечатки набора по остальным вхождениям: «срекотушка» → «скрекотушка» (абзац вовчика) и пропущенный дефис «Мишка скряботушка» (абзац лисички); в том же абзаце добавлено тире перед «Иди.». Не озвучиваются номер и заголовок «1. РУКАВИЧКА.» и русская помета о записи (она в выходных данных).',
    },
    textSha256:
      '112ae0a2bc8e83280e1be7bd4edb4b444e8d645561f39ba832adfc8edd1ace86',
    adaptation: null,
    chapters: [
      {
        title: 'Загублена рукавичка',
        scene: 'mitten',
        text: 'Був собі дід, та загубив рукавичку. От біжить мишка, улізла в ту рукавичку та, й сидить. А це скаче жаба, та й каже: «Хто, хто у цій рукавицці?» — «Мишка-скряботушка. А ти хто?» — «Жабка-скрекотушка. Пусти и мене.» — «Иди.»',
      },
      {
        title: 'Зайчик, лисичка, вовчик',
        scene: 'mitten',
        text: 'От біжить зайчик, та й каже: «Хто, хто у цій рукавицці?» — «Мишка-скряботушка й жабка-скрекотушка. А ти хто?» — «Зайчик-лапанчик. Пустіть и мене.» — «Иди.» Коли це біжить лисичка: «Хто, хто у цій рукавицці?» — «Мишка-скряботушка, жабка-скрекотушка и зайчик-лапанчик. А ти хто?» — «Лисичка-сестричка. Пустіть и мене.» — «Иди.» От вони сидять; біжить вовчик и питає: «Хто, хто у цій рукавицці?» — «Мишка-скряботушка, жабка-скрекотушка, зайчик-лапанчик, та сестричка-лисичка. А ти хто?» — «Вовчик-братік. Пустіть и мене.» — «Иди.»',
      },
      {
        title: 'Ведмідь, кабан і стрілець',
        scene: 'mitten',
        text: 'Коли йде ведмідь, гуде и питаєцця: «Хто, хто в цій рукавицці?» — «Мишка-скряботушка, жабка-скрекотушка, зайчик-лапанчик, лисичка-сестричка и вовчик-братік. А ти хто?» — «Ведмідь-набрідь. Пустіть и мене в рукавичку.» — «Иди.» От, и той уліз. Біжить кабан: «Хро-хро-хро! хто, хто в цій рукавицці?» — «Мишка-скряботушка, жабка-скрекотушка, зайчик-лапанчик, лисичка-сестричка, вовчик-братік и ведмідь-набрідь. А ти хто?» — «Кабан-неклан. Пустіть в рукавичку и мене.» — «Иди.» От и той уліз, тай сидять. Коли це иде стрілець; бачить, що рукавичка ворушицця, — він як стрельне — аж там от-скільки шкур!',
      },
    ],
  },
];

/** Hash of the narrated body (chapter texts, blank-line separated). */
export function storyEditionTextSha256(
  chapters: readonly { text: string }[],
): string {
  return createHash('sha256')
    .update(chapters.map((c) => c.text).join('\n\n'))
    .digest('hex');
}

/** Why an edition is not offered in the wizard; null = available. */
export function storyEditionBlocker(
  edition: StoryEdition,
  registry: readonly StoryEdition[] = STORY_EDITIONS,
): string | null {
  if (edition.status !== 'approved')
    return edition.status === 'retired'
      ? 'Редакция снята с каталога'
      : 'Кандидат: редакция ещё не утверждена';
  if (edition.legal.status === 'unknown')
    return 'Права на текст не подтверждены';
  if (storyEditionTextSha256(edition.chapters) !== edition.textSha256)
    return 'SHA-256 текста не совпадает с реестром';
  if (edition.kind === 'classic' && !edition.textVerification)
    return 'Классика без сверки со сканом';
  if (
    edition.kind === 'classic' &&
    (!edition.source.scanUrl || !edition.source.scanSha256)
  )
    return 'Классика без SHA-256 файла скана';
  if (edition.kind === 'adaptation') {
    if (!edition.adaptation?.changes.length)
      return 'Адаптация без перечня изменений';
    const id = edition.adaptation.classicEditionId;
    if (id && !registry.some((e) => e.id === id && e.kind === 'classic'))
      return 'Адаптация ссылается на отсутствующую классику';
  }
  return null;
}

/** All structural problems of a registry; empty array = consistent. */
export function validateStoryEditions(
  registry: readonly StoryEdition[],
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const date = /^\d{4}-\d{2}-\d{2}$/;
  for (const e of registry) {
    const at = (msg: string) => problems.push(`${e.id}: ${msg}`);
    if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(e.id)) at('недопустимый id');
    if (ids.has(e.id)) at('повтор id');
    ids.add(e.id);
    if (!/^[a-f0-9]{64}$/.test(e.textSha256)) at('textSha256 не задан');
    else if (storyEditionTextSha256(e.chapters) !== e.textSha256)
      at('textSha256 не совпадает с текстом');
    if (!e.chapters.length || e.chapters.some((c) => !c.text.trim()))
      at('пустой текст');
    if (!date.test(e.legal.checkedAt)) at('нет даты проверки прав');
    if (!e.legal.basis.trim()) at('нет основания правового статуса');
    if (!e.responsible.trim()) at('нет ответственного');
    if (e.source.scanSha256 && !/^[a-f0-9]{64}$/.test(e.source.scanSha256))
      at('scanSha256 не SHA-256');
    for (const url of [
      e.source.textUrl,
      e.source.plotUrl,
      e.source.scanUrl,
      e.adaptation?.plotSourceUrl,
    ])
      if (url && !url.startsWith('https://')) at(`источник не https: ${url}`);
    if (e.kind === 'classic') {
      if (e.status === 'approved' && e.legal.status === 'unknown')
        at('утверждённая классика без подтверждённых прав');
      if (e.status === 'approved' && !e.textVerification)
        at('утверждённая классика без сверки текста');
      if (!e.publication || !e.source.textUrl)
        at('классика без издания или ссылки на текст');
      else if (!e.publication.year || !e.publication.pages)
        at('классика без года или страниц издания');
      if (!e.author?.trim()) at('классика без автора или собирателя');
      // A scan comparison is only provable when the compared file is pinned.
      if (
        (e.status === 'approved' || e.textVerification) &&
        (!e.source.scanUrl || !e.source.scanSha256)
      )
        at('сверенная классика без скана или его SHA-256');
      if (e.adaptation) at('у классики не бывает перечня изменений сюжета');
    }
    if (e.kind === 'adaptation') {
      if (!e.adaptation) at('адаптация без описания отличий');
      else {
        if (!e.adaptation.changes.length) at('адаптация без перечня изменений');
        if (!e.adaptation.plotSourceUrl) at('адаптация без источника сюжета');
        const classic = e.adaptation.classicEditionId;
        if (
          classic &&
          !registry.some((x) => x.id === classic && x.kind === 'classic')
        )
          at(`ссылка на несуществующую классику ${classic}`);
      }
    }
    if (e.kind === 'original' && e.adaptation)
      at('оригинальный текст не может быть адаптацией');
    if (e.textVerification && !date.test(e.textVerification.verifiedAt))
      at('нет даты сверки текста');
  }
  return problems;
}

export function storyEdition(id: string): StoryEdition | undefined {
  return STORY_EDITIONS.find((e) => e.id === id);
}

/** Owner-facing registry view for GET /story-gifts/editions (no full text). */
export function storyEditionView(
  edition: StoryEdition,
  registry: readonly StoryEdition[] = STORY_EDITIONS,
) {
  const blocker = storyEditionBlocker(edition, registry);
  const classic = edition.adaptation?.classicEditionId
    ? registry.find((e) => e.id === edition.adaptation!.classicEditionId)
    : undefined;
  const chars = (e: StoryEdition) =>
    e.chapters.reduce((n, c) => n + c.text.length, 0);
  return {
    id: edition.id,
    kind: edition.kind,
    kindLabel:
      edition.kind === 'classic'
        ? 'классика'
        : edition.kind === 'adaptation'
          ? 'адаптация'
          : 'авторская',
    locale: edition.locale,
    countries: edition.countries,
    title: edition.title,
    revision: edition.revision,
    ageBand: edition.ageBand,
    targetSeconds: edition.targetSeconds,
    author: edition.author,
    translator: edition.translator,
    publication: edition.publication,
    source: edition.source,
    legal: edition.legal,
    responsible: edition.responsible,
    status: edition.status,
    textVerification: edition.textVerification,
    textSha256: edition.textSha256,
    textHashVerified:
      storyEditionTextSha256(edition.chapters) === edition.textSha256,
    availableInWizard: blocker === null,
    blocker,
    chapterTitles: edition.chapters.map((c) => c.title),
    characters: chars(edition),
    adaptation: edition.adaptation
      ? {
          ...edition.adaptation,
          classic: classic
            ? {
                id: classic.id,
                title: classic.title,
                status: classic.status,
                chapters: classic.chapters.length,
                characters: chars(classic),
              }
            : null,
          comparedWith: classic
            ? 'registered-classic'
            : ('plot-source' as 'registered-classic' | 'plot-source'),
        }
      : null,
  };
}

/** GET /story-gifts/editions: whole registry incl. candidate/retired, no texts. */
export function storyEditionsList() {
  return STORY_EDITIONS.map((e) => storyEditionView(e));
}
