/** Original pilot story; no third-party edition, translation or family data. */
export const STORY_VOICE = 'a9fc5a41'; // Approved Nova: never substitute silently.
const ORIGINAL_STORY = [
  {
    id: 'little-lantern-ru-v1',
    locale: 'ru',
    title: 'Фонарик для звезды',
    revision: '1',
    ageBand: '4–8',
    rights:
      'Оригинальный текст платформы, редакция 1. Не адаптация стороннего издания.',
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
] as const;
export interface StoryCatalogEntry {
  id: string;
  locale: string;
  title: string;
  revision: string;
  ageBand: string;
  rights: string;
  countries: string[];
  targetSeconds: number;
  kind: 'classic' | 'adaptation' | 'original';
  sourceUrl?: string;
  chapters: { title: string; scene: string; text: string }[];
}
const mittenSource =
  'https://uk.wikisource.org/wiki/Народныя_южнорусскія_сказки/2/1';
const pigsSource =
  'https://en.wikisource.org/wiki/English_Fairy_Tales/The_Story_of_the_Three_Little_Pigs';
const shortRights =
  'Короткий авторский пересказ народного сюжета. Мягкий финал; не текст современного издания.';
export const STORY_CATALOG: StoryCatalogEntry[] = [
  {
    ...ORIGINAL_STORY[0],
    chapters: ORIGINAL_STORY[0].chapters.map((c) => ({ ...c })),
    countries: [],
    targetSeconds: 180,
    kind: 'original',
  },
  {
    id: 'mitten-ru-short-v1',
    locale: 'ru',
    title: 'Рукавичка',
    revision: '1-short',
    ageBand: '3–7',
    rights: shortRights,
    sourceUrl: mittenSource,
    countries: ['UA'],
    targetSeconds: 35,
    kind: 'adaptation',
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
  {
    id: 'mitten-uk-short-v1',
    locale: 'uk',
    title: 'Рукавичка',
    revision: '1-short',
    ageBand: '3–7',
    rights: shortRights,
    sourceUrl: mittenSource,
    countries: ['UA'],
    targetSeconds: 35,
    kind: 'adaptation',
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
    locale: 'en',
    title: 'The Three Little Pigs',
    revision: '1-short',
    ageBand: '3–7',
    rights: shortRights,
    sourceUrl: pigsSource,
    countries: ['GB', 'US'],
    targetSeconds: 35,
    kind: 'adaptation',
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
    locale: 'ru',
    title: 'Три поросёнка',
    revision: '1-short',
    ageBand: '3–7',
    rights: shortRights,
    sourceUrl: pigsSource,
    countries: ['GB', 'US', 'OTHER', 'DE', 'ES'],
    targetSeconds: 35,
    kind: 'adaptation',
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
];
export function storyText(catalogId = 'little-lantern-ru-v1') {
  const story = STORY_CATALOG.find((s) => s.id === catalogId);
  if (!story) throw new Error('Unknown story revision');
  return `${story.title}.\n\n${story.chapters.map((c) => c.text).join('\n\n')}`;
}
export function escapeStoryHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
}
/** Shared by the catalogue, owner preview and public gift; no external images. */
export function storyIllustration(scene: string): string {
  if (scene === 'mitten')
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" role="img" aria-label="Рукавичка в зимнем лесу"><rect width="640" height="360" rx="24" fill="#dcebf0"/><path d="M0 285Q160 220 320 280T640 255V360H0" fill="#f9fcfc"/><path d="M55 260L120 65L185 260ZM460 270L530 80L605 270Z" fill="#4f7774"/><path d="M270 285V175Q270 145 300 145H330Q360 145 360 175V205L380 185Q403 170 416 190Q425 210 405 230L360 280V300H270Z" fill="#cd745d"/><path d="M270 277H360V304H270Z" fill="#efc18d"/><circle cx="250" cy="299" r="16" fill="#a6adb7"/><circle cx="240" cy="285" r="8" fill="#c8cdd2"/><circle cx="260" cy="285" r="8" fill="#c8cdd2"/><circle cx="248" cy="298" r="2"/></svg>`;
  if (scene === 'pigs')
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" role="img" aria-label="Три поросёнка у кирпичного дома"><rect width="640" height="360" rx="24" fill="#cfe5e5"/><path d="M0 265Q320 190 640 250V360H0" fill="#86a986"/><path d="M360 135L465 55L570 135" fill="#936b5d"/><rect x="375" y="135" width="180" height="145" rx="8" fill="#ca8d72"/><rect x="440" y="205" width="42" height="75" fill="#6d7769"/>${[120, 210, 300].map((x) => `<ellipse cx="${x}" cy="275" rx="34" ry="29" fill="#e6aba2"/><path d="M${x - 22} 238L${x - 24} 211L${x - 3} 233L${x + 22} 211L${x + 24} 238" fill="#e6aba2"/><circle cx="${x}" cy="248" r="28" fill="#f4c2b7"/><ellipse cx="${x}" cy="257" rx="15" ry="10" fill="#d79890"/><circle cx="${x - 6}" cy="257" r="2"/><circle cx="${x + 6}" cy="257" r="2"/><circle cx="${x - 10}" cy="242" r="2"/><circle cx="${x + 10}" cy="242" r="2"/>`).join('')}</svg>`;
  const stars = scene === 'stars';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" role="img" aria-label="Иллюстрация лесной сказки"><rect width="640" height="360" rx="24" fill="${stars ? '#162340' : '#274c54'}"/><circle cx="505" cy="72" r="35" fill="#ffdf9d"/><path d="M0 260 Q150 170 320 265 T640 240 V360 H0Z" fill="#376554"/><path d="M60 275L120 90L180 275Z M465 290L535 115L610 290Z" fill="#143f39"/><path d="M230 360Q350 240 420 360" fill="#648779"/><ellipse cx="315" cy="292" rx="51" ry="27" fill="#dd995c"/><path d="M280 276L278 214L302 234L327 215L341 278Z" fill="#e5a56b"/><path d="M289 259L310 279L333 254" fill="#ffe4bb"/><circle cx="296" cy="251" r="3"/><circle cx="323" cy="251" r="3"/><circle cx="374" cy="267" r="39" fill="#ffde9a" opacity=".2"/><rect x="361" y="252" width="26" height="34" rx="6" fill="#ffdf92"/><path d="M365 252V244Q374 230 383 244V252" fill="none" stroke="#e1b46b" stroke-width="4"/>${stars ? '<path d="M230 55l4 10 11 1-9 7 3 11-9-6-9 6 3-11-9-7 11-1Z" fill="#ffedbb"/>' : ''}</svg>`;
}
