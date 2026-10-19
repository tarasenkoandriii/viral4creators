import { BadRequestException } from '@nestjs/common';
import { toWellFormedStoryText } from './story-gift-note';

/**
 * Р-ST-WP3-4. Валидатор запрещённых обещаний в словах взрослого, которые
 * услышит ребёнок: реплика о физическом подарке, преамбула видео (WP4),
 * подпись повода и описание фото подарка.
 *
 * Три класса блокируются (400 с машинным кодом):
 *  - `return-date` — дата/срок возвращения или встречи: глагол возвращения
 *    В ОДНОМ предложении с указанием времени («завтра», «скоро», «через
 *    неделю», «в мае», «12.05», «двенадцатого мая», «on May the 12th»).
 *    Отдельно — обратный отсчёт «через N дней/недель/месяцев»: запись
 *    переслушивают в любой день, поэтому любой отсчёт в ней неверен при
 *    повторе и для ребёнка в разлуке неотличим от срока возвращения;
 *  - `therapy` — обещание лечебного/психологического эффекта («вылечит»,
 *    «перестанешь бояться», «терапия», «поможет уснуть»);
 *  - `delivery` — выдуманный статус физического подарка: курьер, доставка,
 *    «уже едет», «привезут», «по почте», «your gift is on its way». Продукт
 *    не знает и не проверяет наличие и доставку, а запись остаётся
 *    неизменной, когда статус меняется.
 *
 * Граница (B-S3-1, 19.10.2026; тесты — story-gift-occasion.spec.ts):
 *  - глагол возвращения — это «вернуться/возвращаться» в любом лице
 *    («папа вернётся 12.05» — ровно то обещание, ради которого валидатор),
 *    а глаголы прибытия «приехать/прийти/прилететь» — только в 1-м лице
 *    («приеду», «приду», «прилечу», «буду дома», «увидимся»), с «к тебе /
 *    домой / за тобой» или с членом семьи подлежащим («мама скоро придёт»).
 *    Поэтому «Скоро придут гости», «скоро наступит утро», «я буду рядом» —
 *    допустимы;
 *  - обратный отсчёт требует ЧИСЛИТЕЛЬНОГО прямо перед единицей времени
 *    (цифры или словарь: один…десять, -надцать, двадцать, пару, несколько,
 *    много, пол-/пів-; uk/en аналоги). «Шли через лес целый день», «ехали
 *    через поле два дня» — не срок;
 *  - дата прописью: месяц в родительном падеже рядом с глаголом возвращения
 *    («двенадцатого мая», «двадцять першого травня») и английская дата
 *    («the twelfth of May», «on May the 12th», «May 12») — срок. «марта»,
 *    «мая» (имена Марта, Мая) и укр. «лютого» (прилагательное) считаются
 *    месяцем только с числом/порядковым числительным перед ними;
 *  - EN «on the way home / On the way to the forest» — не доставка:
 *    «on its/the way» блокируется только вместе с подарком в той же фразе
 *    (gift/present/package/parcel/box/surprise) или с подлежащим «it/they»
 *    («It is on its way», «Your gift is on the way»).
 *
 * Сознательно ДОПУСТИМО (не блокируется, проверено тестами):
 *  - «я тебя люблю», «скучаю», «спокойной ночи» — это утверждённый взрослым
 *    текст, не обещание;
 *  - «завтра почитаем ещё» — не срок возвращения и выполнимо повтором
 *    записи; блокировка таких бытовых фраз толкала бы к обходу проверки.
 *    Взамен предпросмотр показывает мягкое предупреждение
 *    `STORY_HINT_RELATIVE_TIME`;
 *  - «когда я вернусь, мы…» без даты — не дата; предупреждение
 *    `STORY_HINT_RETURN_WITHOUT_DATE`, решение остаётся за взрослым;
 *  - «с этой книжкой ты не будешь скучать» — «скучать» здесь чаще «будет
 *    не скучно», а не терапевтическое «перестанешь тосковать»: только
 *    подсказка `STORY_HINT_FEELING_PROMISE`. «Больше не будешь скучать»,
 *    «перестанешь скучать» — по-прежнему блок `therapy`.
 *
 * Проверяются шаблоны всех трёх языков независимо от `locale` (реплика на
 * украинском в русской сказке не должна проскочить); `locale` задаёт только
 * порядок проверки. Сравнение идёт по свёрнутому тексту (`foldStoryText`):
 * без одиночных суррогатов, NFKD → без ударений U+0300/U+0301 → NFKC → без
 * оставшихся комбинируемых знаков \p{M} и невидимых символов \p{Cf},
 * нижний регистр, ё→е, единый апостроф; двойники латиница/кириллица
 * сводятся в обе стороны (B-S3-2): для шаблонов ru/uk латинские двойники
 * в смешанных словах (и слова целиком из латинских двойников) → кириллица,
 * для шаблонов en — наоборот.
 */
export type StoryPromiseLocale = 'ru' | 'uk' | 'en';
export type StoryPromiseKind = 'return-date' | 'therapy' | 'delivery';
export const STORY_PROMISE_CODES: Readonly<Record<StoryPromiseKind, string>> = {
  'return-date': 'STORY_PROMISE_RETURN_DATE',
  therapy: 'STORY_PROMISE_THERAPY',
  delivery: 'STORY_PROMISE_DELIVERY',
};
const MESSAGES: Readonly<Record<StoryPromiseKind, string>> = {
  'return-date':
    'Уберите дату или срок возвращения/встречи: запись могут переслушивать в любой день, обещание срока в ней недопустимо',
  therapy:
    'Уберите обещание лечебного или психологического эффекта: сказка не терапия и не гарантирует результат',
  delivery:
    'Уберите упоминание доставки, курьера или сроков получения подарка: сервис не знает и не проверяет его доставку',
};
export type StoryPromiseHint = {
  code:
    | 'STORY_HINT_RELATIVE_TIME'
    | 'STORY_HINT_RETURN_WITHOUT_DATE'
    | 'STORY_HINT_FEELING_PROMISE';
  message: string;
};
export type StoryPromiseCheck = {
  violation: null | { kind: StoryPromiseKind; code: string; message: string };
  hints: StoryPromiseHint[];
};

const L = '\\p{L}\\p{N}';
const B = `(?<![${L}'])`;
const E = `(?![${L}'])`;
const rx = (body: string) => new RegExp(`${B}(?:${body})${E}`, 'u');

const RU_MONTH =
  '(?:январ|феврал|март|апрел|ма[йяе]|июн|июл|август|сентябр|октябр|ноябр|декабр)\\p{L}*';
const UK_MONTH =
  '(?:січн|лют|берез|квітн|травн|червн|липн|серпн|верес|жовтн|листопад|грудн)\\p{L}*';
const EN_MONTH =
  '(?:january|february|march|april|may|june|july|august|september|october|november|december)';
const NUM_DATE = '\\d{1,2}[./]\\d{1,2}(?:[./]\\d{2,4})?';
const W = `[${L}'-]+`;

// Числительные прямо перед единицей времени (B-S3-1): без них «через лес
// целый день» — не отсчёт.
const RU_NUM_WORD =
  '\\d+(?:[.,]\\d+)?|од(?:ин|ну|на|ного|ной)|дв(?:а|е|ух)|тр(?:и|ех)|четыр(?:е|ех)|пят(?:ь|и)|шест(?:ь|и)|сем(?:ь|и)|восем(?:ь|и)|восьми|девят(?:ь|и)|десят(?:ь|и|ок|ка)|\\p{L}+надцат(?:ь|и)|двадцат(?:ь|и)|тридцат(?:ь|и)|сорок(?:а)?|сто|пар(?:у|ы|очку)|пару-тройку|нескольк\\p{L}*|немного|много|многие|многих|считанн\\p{L}*|пол|полтора|полторы';
const RU_NUM = `(?:${RU_NUM_WORD})(?:[ -](?:${RU_NUM_WORD}))?`;
const RU_UNIT =
  '(?:день|дня|дней|дн|сутки|суток|недел\\p{L}*|месяц\\p{L}*|год|года|годик\\p{L}*|лет|ночь|ночи|ночей|сна|снов|выходн\\p{L}*)';
const UK_NUM_WORD =
  "\\d+(?:[.,]\\d+)?|од(?:ин|ну|на|ного|нієї)|дв(?:а|і|ох)|тр(?:и|ьох)|чотир(?:и|ьох)|п'ят(?:ь|и|ьох)|шіст(?:ь|и|ьох)|сім|семи|сімох|вісім|восьми|дев'ят(?:ь|и|ьох)|десят(?:ь|и|ьох|ок)|\\p{L}+надцят(?:ь|и|ьох)|двадцят(?:ь|и)|тридцят(?:ь|и)|сорок(?:а)?|сто|пар(?:у|и|очку)|кільк\\p{L}*|декільк\\p{L}*|небагато|багато|пів|півтора|півтори";
const UK_NUM = `(?:${UK_NUM_WORD})(?:[ -](?:${UK_NUM_WORD}))?`;
const UK_UNIT =
  '(?:день|дні|днів|доб(?:а|у|и)|тиждень|тижні|тижнів|місяць|місяці|місяців|рік|роки|років|року|ночі|ночей|сни|снів|вихідн\\p{L}*)';
const EN_NUM_WORD =
  'a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a few|a couple of|a couple|couple of|few|several|many|half a|\\d+';
const EN_NUMBER = `(?:${EN_NUM_WORD})(?:(?: or |-| to )(?:${EN_NUM_WORD}))?`;
const EN_UNIT = '(?:days?|weeks?|months?|years?|nights?|sleeps?)';
const EN_ORD =
  '(?:(?:twenty|thirty)[- ]?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)';
const EN_DAY = `(?:\\d{1,2}(?:st|nd|rd|th)?|${EN_ORD})`;

const RU_COUNTDOWN = `через ${RU_NUM} ${RU_UNIT}|через (?:неделю|месяц|год|полгода|полмесяца|полнедели|сутки|пол-года|пол-месяца)|остал(?:ось|ся|ась|ись) ${RU_NUM} ${RU_UNIT}`;
const UK_COUNTDOWN = `через ${UK_NUM} ${UK_UNIT}|через (?:тиждень|місяць|рік|півроку|півмісяця|добу|пів-року)|(?:залишилось|залишилося|лишилось|лишилося|залишився|лишився) ${UK_NUM} ${UK_UNIT}`;
// «N days left/to go/until»: без артикля («a day left behind» — не отсчёт).
const EN_COUNT =
  '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a few|few|several|a couple of|couple of)';
const EN_COUNTDOWN = `in ${EN_NUMBER} ${EN_UNIT}|${EN_COUNT} (?:more )?${EN_UNIT} (?:left|to go|until)`;

// Дата прописью (B-S3-2): месяц в родительном падеже. «марта»/«мая» — ещё
// и имена (Марта, Мая), поэтому только с числом/порядковым перед ними.
const RU_MONTH_GEN_SAFE =
  'января|февраля|апреля|июня|июля|августа|сентября|октября|ноября|декабря';
const RU_MONTH_GEN = `${RU_MONTH_GEN_SAFE}|марта|мая`;
const RU_DATE_WORDS = `(?:\\p{L}+(?:ого|его|ое|ее)|\\d{1,2}(?:-?(?:го|ое|е))?)(?: числа)? (?:${RU_MONTH_GEN})|${RU_MONTH_GEN_SAFE}|\\p{L}+(?:ого|его) числа`;
// укр. «лютого» — и прикметник («лютого вовка»): тільки з числом.
const UK_MONTH_GEN_SAFE =
  'січня|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня';
const UK_MONTH_GEN = `${UK_MONTH_GEN_SAFE}|лютого`;
const UK_DATE_WORDS = `(?:\\p{L}+ого|\\d{1,2}(?:-?(?:го|е))?)(?: числа)? (?:${UK_MONTH_GEN})|${UK_MONTH_GEN_SAFE}|\\p{L}+ого числа`;
const EN_DATE_WORDS = `(?:the )?${EN_DAY} of ${EN_MONTH}|${EN_MONTH} (?:the )?${EN_DAY}|on the \\d{1,2}(?:st|nd|rd|th)|at \\d{1,2}(?::\\d{2})? ?(?:o'clock|am|pm)|at (?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) o'clock`;

// Глаголы прибытия в 3-м лице — только с «к тебе/домой/за тобой» или
// с членом семьи подлежащим (B-S3-1).
const RU_ARRIVE3 =
  'приедет|приедут|приедешь|прилетит|прилетят|прилетишь|придет|придут|придешь';
const RU_FAMILY =
  'мама|мамочка|мамуля|папа|папочка|папуля|бабушка|бабуля|дедушка|дедуля|тетя|дядя|брат|братик|сестра|сестренка';
const RU_TO_YOU = 'к тебе|домой|за тобой';
const UK_ARRIVE3 =
  'приїде|приїдуть|приїдеш|прилетить|прилетять|прилетиш|прийде|прийдуть|прийдеш';
const UK_FAMILY =
  'мама|мамуся|матуся|тато|татко|татусь|бабуся|бабця|дідусь|дідо|тітка|дядько|брат|братик|сестра|сестричка';
const UK_TO_YOU = 'до тебе|додому|за тобою';

const PATTERNS: Record<
  StoryPromiseLocale,
  {
    returnVerb: RegExp;
    time: RegExp;
    countdown: RegExp;
    therapy: RegExp;
    delivery: RegExp;
    /** Доставка, требующая подарка/«it» в той же фразе. */
    deliveryInSentence?: { phrase: RegExp; subject: RegExp };
    relative: RegExp;
    feeling?: RegExp;
  }
> = {
  ru: {
    returnVerb: rx(
      `верн(?:усь|емся|ется|утся|ешься)|возвраща(?:юсь|емся|ется|ются)|приеду|приедем|прилечу|прилетим|приду|придем|буду дома|будем дома|буду с тобой|будем с тобой|будем вместе|увидимся|встретимся|обниму|обнимемся|заберу тебя|приду за тобой|(?:${RU_ARRIVE3})(?: ${W})? (?:${RU_TO_YOU})|(?:${RU_TO_YOU})(?: ${W})? (?:${RU_ARRIVE3})|(?:${RU_FAMILY})(?: ${W})? (?:${RU_ARRIVE3})`,
    ),
    time: rx(
      `завтра|послезавтра|скоро|совсем скоро|на днях|в ближайшее время|${RU_COUNTDOWN}|через (?:${RU_NUM} )?(?:час\\p{L}*|минут\\p{L}*)|через полчаса|в (?:${RU_NUM}) час\\p{L}*|в \\p{L}+(?:ом|ем) часу|в \\d{1,2}:\\d{2}|(?:в|во|к|до|после) (?:понедельник|вторник|сред[уы]|четверг\\p{L}*|пятниц\\p{L}*|суббот\\p{L}*|воскресень\\p{L}*)|(?:в|к|до|после|в начале|в конце|в середине) ${RU_MONTH}|\\d{1,2} ${RU_MONTH}|${RU_DATE_WORDS}|${NUM_DATE}|к (?:новому году|лету|зиме|осени|весне|празднику|праздникам|выходным|твоему дню рождения|дню рождения|рождеству)|(?:на|к) (?:этой|следующей) неделе|на выходных|в выходные|(?:этим|следующим) (?:летом|зимой|осенью|весной)|летом|зимой|осенью|весной|(?:до|после) (?:лета|зимы|осени|весны|нового года|праздников)|(?:в|на) следующ\\p{L}+ (?:году|месяце|неделе)`,
    ),
    countdown: rx(RU_COUNTDOWN),
    therapy: rx(
      'терапи\\p{L}*|терапевт\\p{L}*|психотерап\\p{L}*|лечебн\\p{L}*|вылеч\\p{L}*|излеч\\p{L}*|исцел\\p{L}*|лечит|лечат|перестанешь (?:бояться|скучать|плакать|переживать|волноваться|грустить|тревожиться)|больше не будешь (?:бояться|скучать|плакать|переживать|волноваться|грустить)|не будешь (?:бояться|плакать|грустить)|(?:страх\\p{L}*|тревог\\p{L}*|тоска|грусть|боль|кошмар\\p{L}*) (?:уйдет|уйдут|пройдет|пройдут|исчезнет|исчезнут|отступит|отступят)|поможет (?:тебе )?(?:уснуть|заснуть|не бояться|перестать бояться|не скучать|справиться|успокоиться)|избав\\p{L}* (?:тебя )?от (?:страх|тревог|кошмар|бессонниц)\\p{L}*|снимет (?:тревог|стресс|страх)\\p{L}*|успокоит (?:тебя|твою|твои)',
    ),
    delivery: rx(
      'курьер\\p{L}*|доставк\\p{L}*|доставят|доставит|доставим|доставлю|привезут|привезет|привезу|привезем|уже едет|уже в пути|(?:подарок|посылка|коробка) (?:уже )?(?:в пути|едет|идет|придет|приедет)|по почте|почтой|посылк\\p{L}* (?:придет|приедет|прибудет)|прибудет|получишь (?:его |ее |подарок |посылку )?(?:завтра|послезавтра|скоро|через)',
    ),
    relative: rx('завтра|послезавтра|сегодня вечером|на днях'),
    feeling: rx('не будешь скучать'),
  },
  uk: {
    returnVerb: rx(
      `поверн(?:уся|усь|емося|емось|еться|уться|ешся)|поверта(?:юся|юсь|ємося|ємось|ється|ються)|приїду|приїдемо|прилечу|прилетимо|прийду|прийдемо|буду вдома|будемо вдома|буду з тобою|будемо з тобою|будемо разом|побачимося|побачимось|зустрінемося|зустрінемось|обійму|обіймемося|обіймемось|заберу тебе|(?:${UK_ARRIVE3})(?: ${W})? (?:${UK_TO_YOU})|(?:${UK_TO_YOU})(?: ${W})? (?:${UK_ARRIVE3})|(?:${UK_FAMILY})(?: ${W})? (?:${UK_ARRIVE3})`,
    ),
    time: rx(
      `завтра|післязавтра|скоро|незабаром|найближчим часом|цими днями|${UK_COUNTDOWN}|через (?:${UK_NUM} )?(?:годин\\p{L}*|хвилин\\p{L}*)|через півгодини|о (?:\\d{1,2}(?::\\d{2})?|\\p{L}+ій) годин\\p{L}*|(?:у|в|до|після|на) (?:понеділ\\p{L}*|вівтор\\p{L}*|серед\\p{L}*|четвер\\p{L}*|п'ятниц\\p{L}*|субот\\p{L}*|неділ\\p{L}*)|(?:у|в|до|після|на початку|наприкінці|в середині|у середині) ${UK_MONTH}|\\d{1,2} ${UK_MONTH}|${UK_DATE_WORDS}|${NUM_DATE}|до (?:нового року|літа|зими|осені|весни|свят|вихідних|твого дня народження|дня народження|різдва)|на (?:цьому|наступному) тижні|на вихідних|(?:цього|наступного) (?:літа|року|місяця)|влітку|взимку|восени|навесні|(?:у|в|на) наступн\\p{L}+ (?:році|місяці|тижні)`,
    ),
    countdown: rx(UK_COUNTDOWN),
    therapy: rx(
      'терапі\\p{L}*|терапевт\\p{L}*|психотерап\\p{L}*|лікувальн\\p{L}*|вилік\\p{L}*|зціл\\p{L}*|лікує|лікують|перестанеш (?:боятися|сумувати|плакати|хвилюватися|тривожитися)|більше не будеш (?:боятися|сумувати|плакати|хвилюватися)|не будеш (?:боятися|сумувати|плакати)|(?:страх\\p{L}*|тривог\\p{L}*|сум|туга|біль|жах\\p{L}*) (?:мине|минуть|зникне|зникнуть|пройде|пройдуть|відступить)|допоможе (?:тобі )?(?:заснути|уснути|не боятися|перестати боятися|не сумувати|впоратися|заспокоїтися)|позбав\\p{L}* (?:тебе )?(?:від )?(?:страх|тривог|жах|безсонн)\\p{L}*|заспокоїть (?:тебе|твій|твої)',
    ),
    delivery: rx(
      "кур'?єр\\p{L}*|доставк\\p{L}*|доставлять|доставить|доставимо|доставлю|привезуть|привезе|привезу|привеземо|вже їде|вже в дорозі|(?:подарунок|посилка|коробка) (?:вже )?(?:в дорозі|їде|йде|прийде|приїде)|поштою|по пошті|посилк\\p{L}* (?:прийде|приїде|прибуде)|прибуде|отримаєш (?:його |її |подарунок |посилку )?(?:завтра|післязавтра|скоро|незабаром|через)",
    ),
    relative: rx('завтра|післязавтра|сьогодні ввечері|цими днями'),
  },
  en: {
    returnVerb: rx(
      "i'?ll be (?:back|home|there|with you)|i will be (?:back|home|there|with you)|i'?ll come (?:back|home)|i will come (?:back|home)|i'?m coming (?:back|home)|i am coming (?:back|home)|i'?ll return|i will return|will be home|be back|come home|see you|we'?ll see each other|we will see each other|we'?ll be together|we will be together|i'?ll hug you|i will hug you|i'?ll pick you up|i will pick you up",
    ),
    time: rx(
      `tomorrow|the day after tomorrow|soon|very soon|shortly|next (?:week|month|year|weekend|time|monday|tuesday|wednesday|thursday|friday|saturday|sunday|summer|winter|spring|autumn|fall)|${EN_COUNTDOWN}|in ${EN_NUMBER} (?:hours?|minutes?)|in (?:a|one) (?:week|month|year)|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|by (?:christmas|new year|summer|winter|spring|autumn|fall|your birthday|the weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|this (?:weekend|week|month|summer|winter|spring|autumn|fall)|(?:in|before|after|by) ${EN_MONTH}|${EN_MONTH} \\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)? of ${EN_MONTH}|${EN_DATE_WORDS}|${NUM_DATE}`,
    ),
    countdown: rx(EN_COUNTDOWN),
    therapy: rx(
      "therap\\p{L}*|cure[sd]?|curing|heal(?:s|ed|ing)?|you'?ll (?:stop|no longer|never again) (?:be scared|be afraid|be sad|feel sad|feel scared|fear|miss|cry|worry)|you will (?:stop|no longer|never again) (?:be scared|be afraid|be sad|feel sad|fear|miss|cry|worry)|won'?t be (?:scared|afraid|sad|anxious|lonely) any ?more|(?:fears?|anxiety|sadness|pain|nightmares?) will (?:go away|disappear|fade|vanish|stop)|helps? you (?:sleep|fall asleep|stop being|not be|cope|overcome|calm down|feel better)|will help you (?:sleep|fall asleep|cope|calm down|feel better)|make (?:your|the) (?:fears?|anxiety|sadness|nightmares?) go away|reduces? (?:anxiety|stress|fear)",
    ),
    delivery: rx(
      'courier\\p{L}*|deliver(?:y|ies|ed|s|ing)?|shipp(?:ed|ing)|in the (?:mail|post)|by (?:mail|post)|(?:will|should|is going to) (?:arrive|come) (?:tomorrow|soon|on|in|by|next)|arriv(?:es|ing) (?:tomorrow|soon|on|in|by|next)|(?:parcel|package) will',
    ),
    // B-S3-1: «on the way home» / «On the way to the forest» — не доставка.
    deliveryInSentence: {
      phrase: rx(
        'on (?:its|their|his|her|my|our|your) way(?! (?:home|back|through|across|into|out|along|to (?!you)))|on the way(?: to you| now| already)?(?= ?(?:[,:;—–!-]|$))',
      ),
      subject: rx(
        "gifts?|presents?|parcels?|packages?|box(?:es)?|surprises?|(?:it|they)(?:'s|'re| is| are| will be)?(?: already| now)? on (?:its|their|the) way",
      ),
    },
    relative: rx('tomorrow|tonight|the day after tomorrow'),
  },
};

const LATIN_TO_CYRILLIC: Readonly<Record<string, string>> = {
  A: 'А',
  B: 'В',
  C: 'С',
  E: 'Е',
  H: 'Н',
  I: 'І',
  K: 'К',
  M: 'М',
  O: 'О',
  P: 'Р',
  T: 'Т',
  X: 'Х',
  Y: 'У',
  a: 'а',
  c: 'с',
  e: 'е',
  i: 'і',
  k: 'к',
  o: 'о',
  p: 'р',
  x: 'х',
  y: 'у',
};
const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Object.entries(LATIN_TO_CYRILLIC).map(([lat, cyr]) => [cyr, lat]),
  ),
  // Look-alikes outside Russian/Ukrainian alphabets, used for spoofing.
  Ѕ: 'S',
  ѕ: 's',
  Ј: 'J',
  ј: 'j',
  Һ: 'H',
  һ: 'h',
  ԁ: 'd',
  Ԛ: 'Q',
  ԛ: 'q',
  Ԝ: 'W',
  ԝ: 'w',
};
const IS_LATIN = /[A-Za-z]/;
const IS_CYRILLIC = /[\u0400-\u052F]/;

/** Куда сводить двойники: `auto` — по преобладающему алфавиту слова. */
export type StoryFoldScript = 'auto' | 'cyrillic' | 'latin';

function unifyWord(word: string, script: StoryFoldScript): string {
  const chars = [...word];
  const lat = chars.filter((c) => IS_LATIN.test(c)).length;
  const cyr = chars.filter((c) => IS_CYRILLIC.test(c)).length;
  let target = script;
  if (target === 'auto') {
    if (!lat || !cyr) return word;
    target = lat > cyr ? 'latin' : 'cyrillic';
  }
  const map = target === 'latin' ? CYRILLIC_TO_LATIN : LATIN_TO_CYRILLIC;
  const foreign = target === 'latin' ? cyr : lat;
  const native = target === 'latin' ? lat : cyr;
  if (!foreign) return word;
  // A whole word of foreign letters is converted only when every letter is
  // a look-alike (spoofed word); a genuine word of the other script stays.
  if (
    !native &&
    !chars.every((c) => !(IS_LATIN.test(c) || IS_CYRILLIC.test(c)) || map[c])
  )
    return word;
  return chars.map((c) => map[c] ?? c).join('');
}

/** Цифры даты «12 . 05» и «12/ 05» склеиваются до разбиения на фразы. */
const joinDigits = (text: string) =>
  text.replace(/(\d)[ \t\u00A0]*([./])[ \t\u00A0]*(\d)/g, '$1$2$3');

/**
 * Свёртка для сравнения; не для хранения (B-S3-2). `script` — куда сводить
 * двойники латиница/кириллица: `cyrillic` для шаблонов ru/uk, `latin` для
 * en, `auto` — по большинству букв слова.
 */
export function foldStoryText(
  text: string,
  script: StoryFoldScript = 'auto',
): string {
  return toWellFormedStoryText(text)
    .normalize('NFKD')
    .replace(/[\u0300\u0301]/g, '')
    .normalize('NFKC')
    .replace(/[\p{M}\p{Cf}\u115F\u1160\u3164\uFFA0]/gu, '')
    .replace(/[\p{L}'’ʼ]+/gu, (word) => unifyWord(word, script))
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[’ʼ`´‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
const sentences = (text: string, script: StoryFoldScript) =>
  joinDigits(text)
    .split(/[.!?…;]+(?=\s|$)|\n+/u)
    .map((s) => foldStoryText(s, script))
    .filter(Boolean);
const order = (locale: string): StoryPromiseLocale[] => {
  const first: StoryPromiseLocale =
    locale === 'uk' || locale === 'en' ? locale : 'ru';
  return [first, ...(['ru', 'uk', 'en'] as const).filter((l) => l !== first)];
};
const scriptOf = (lang: StoryPromiseLocale): 'cyrillic' | 'latin' =>
  lang === 'en' ? 'latin' : 'cyrillic';

/** Полная проверка без исключения: нарушение (первое) и мягкие подсказки. */
export function checkStoryPromises(
  text: string,
  locale: string,
): StoryPromiseCheck {
  const folded = {
    cyrillic: {
      parts: sentences(text, 'cyrillic'),
      whole: foldStoryText(joinDigits(text), 'cyrillic'),
    },
    latin: {
      parts: sentences(text, 'latin'),
      whole: foldStoryText(joinDigits(text), 'latin'),
    },
  };
  const langs = order(locale);
  const found = (kind: StoryPromiseKind) => ({
    kind,
    code: STORY_PROMISE_CODES[kind],
    message: MESSAGES[kind],
  });
  let violation: StoryPromiseCheck['violation'] = null;
  for (const lang of langs) {
    const p = PATTERNS[lang];
    const { parts, whole } = folded[scriptOf(lang)];
    const inSentence = p.deliveryInSentence;
    if (
      p.delivery.test(whole) ||
      (inSentence &&
        parts.some(
          (s) => inSentence.phrase.test(s) && inSentence.subject.test(s),
        ))
    )
      violation ??= found('delivery');
    if (p.therapy.test(whole)) violation ??= found('therapy');
    if (
      p.countdown.test(whole) ||
      parts.some((s) => p.returnVerb.test(s) && p.time.test(s))
    )
      violation ??= found('return-date');
  }
  const hints: StoryPromiseHint[] = [];
  if (!violation) {
    const of = (l: StoryPromiseLocale) => folded[scriptOf(l)];
    if (
      langs.some((l) => of(l).parts.some((s) => PATTERNS[l].returnVerb.test(s)))
    )
      hints.push({
        code: 'STORY_HINT_RETURN_WITHOUT_DATE',
        message:
          'Фраза о возвращении или встрече без даты допустима, но проверьте, что она не звучит как обещание: запись будут переслушивать.',
      });
    if (langs.some((l) => PATTERNS[l].relative.test(of(l).whole)))
      hints.push({
        code: 'STORY_HINT_RELATIVE_TIME',
        message:
          'Запись переслушивают в разные дни: слова вроде «завтра» могут звучать неточно при повторе.',
      });
    if (langs.some((l) => PATTERNS[l].feeling?.test(of(l).whole)))
      hints.push({
        code: 'STORY_HINT_FEELING_PROMISE',
        message:
          '«Не будешь скучать» допустимо в значении «будет не скучно», но не обещайте, что ребёнок перестанет тосковать или грустить.',
      });
  }
  return { violation, hints };
}

/**
 * Бросает 400 `{ code: STORY_PROMISE_*, message, reason }` при запрещённом
 * обещании. Для WP4: вызывать для текста преамбулы до любого платного вызова.
 */
export function assertStoryPromiseFree(text: string, locale: string): void {
  const { violation } = checkStoryPromises(text, locale);
  if (violation)
    throw new BadRequestException({
      code: violation.code,
      message: violation.message,
      reason: violation.kind,
    });
}
