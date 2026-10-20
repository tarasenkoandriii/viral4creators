import { BadRequestException } from '@nestjs/common';
import { assertStoryPromiseFree } from './story-promise';

/**
 * Р-ST-WP3-1. Повод — необязательный пресет. Он НЕ меняет текст сказки
 * (классика и адаптации озвучиваются как есть) и влияет только на:
 *  (a) подсказки первой фразы обращения (`storyOccasionLines`, для
 *      преамбулы видео WP4 и для подсказки в мастере);
 *  (b) оформление: идентификатор темы обложки (`occasionTheme`), который
 *      фронтенд превращает в цвет/иконку.
 * `other` — свободная подпись до 80 символов (прежнее поле `occasion`).
 */
export const STORY_OCCASION_KINDS = [
  'birthday',
  'bedtime',
  'separation',
  'support',
  'other',
] as const;
export type StoryOccasionKind = (typeof STORY_OCCASION_KINDS)[number];
/** Р-ST-WP3-2. Тема фиксируется в подарке при создании (снимок оформления). */
export const STORY_THEMES = [
  'calm',
  'celebration',
  'night',
  'warm',
  'gentle',
] as const;
export type StoryTheme = (typeof STORY_THEMES)[number];
const THEME_BY_KIND: Readonly<Record<StoryOccasionKind, StoryTheme>> = {
  birthday: 'celebration',
  bedtime: 'night',
  separation: 'warm',
  support: 'gentle',
  other: 'calm',
};
export function storyOccasionTheme(
  kind?: StoryOccasionKind | string | null,
): StoryTheme {
  return (THEME_BY_KIND as Record<string, StoryTheme>)[kind ?? ''] ?? 'calm';
}
export type StoryLineLocale = 'ru' | 'uk' | 'en';
const DEFAULT_ADDRESS: Readonly<Record<StoryLineLocale, string>> = {
  ru: 'солнышко',
  uk: 'сонечко',
  en: 'sweetheart',
};
type Lines = Readonly<Record<StoryOccasionKind | 'none', readonly string[]>>;
/**
 * Без рода говорящего («у меня для тебя», а не «я приготовил»), без
 * родства, дат, обещаний и терапевтических формулировок: спецификация
 * ST-UX-05 запрещает подставлять пол/родство без подтверждения. Каждая
 * строка проходит `assertStoryPromiseFree` (проверено тестом).
 */
const LINES: Readonly<Record<StoryLineLocale, Lines>> = {
  ru: {
    none: [
      'Привет, {name}! У меня для тебя сказка.',
      '{name}, устраивайся поудобнее — начинаем сказку.',
    ],
    birthday: [
      '{name}, с днём рождения! У меня для тебя сказка.',
      'С днём рождения, {name}! Давай послушаем сказку.',
    ],
    bedtime: [
      '{name}, пора готовиться ко сну. Послушаем сказку?',
      'Спокойной ночи, {name}. Вот сказка перед сном.',
    ],
    separation: [
      'Привет, {name}! Эта сказка — от меня для тебя.',
      '{name}, эту сказку можно включать снова, когда захочется.',
    ],
    support: [
      '{name}, я думаю о тебе. Вот сказка для тебя.',
      '{name}, давай вместе послушаем спокойную сказку.',
    ],
    other: [
      'Привет, {name}! У меня для тебя сказка.',
      '{name}, устраивайся поудобнее — начинаем сказку.',
    ],
  },
  uk: {
    none: [
      'Привіт, {name}! У мене є для тебе казка.',
      '{name}, вмощуйся зручніше — починаємо казку.',
    ],
    birthday: [
      '{name}, з днем народження! У мене є для тебе казка.',
      'З днем народження, {name}! Послухаймо казку.',
    ],
    bedtime: [
      '{name}, час готуватися до сну. Послухаємо казку?',
      'На добраніч, {name}. Ось казка на ніч.',
    ],
    separation: [
      'Привіт, {name}! Ця казка — тобі від мене.',
      '{name}, цю казку можна вмикати знову, коли захочеться.',
    ],
    support: [
      '{name}, я думаю про тебе. Ось казка для тебе.',
      '{name}, послухаймо разом спокійну казку.',
    ],
    other: [
      'Привіт, {name}! У мене є для тебе казка.',
      '{name}, вмощуйся зручніше — починаємо казку.',
    ],
  },
  en: {
    none: [
      'Hi, {name}! I have a story for you.',
      '{name}, get comfy — the story is about to begin.',
    ],
    birthday: [
      'Happy birthday, {name}! I have a story for you.',
      "{name}, happy birthday! Let's listen to a story.",
    ],
    bedtime: [
      "{name}, it's time to get ready for bed. Shall we listen to a story?",
      'Good night, {name}. Here is a bedtime story.',
    ],
    separation: [
      'Hi, {name}! This story is from me to you.',
      '{name}, you can play this story again whenever you like.',
    ],
    support: [
      "{name}, I'm thinking of you. Here is a story for you.",
      "{name}, let's listen to a gentle story together.",
    ],
    other: [
      'Hi, {name}! I have a story for you.',
      '{name}, get comfy — the story is about to begin.',
    ],
  },
};
/** Имя/домашнее обращение: только буквы, пробел, дефис, апостроф; ≤40. */
export function normalizeStoryChildName(name?: string | null): string | null {
  const value = (name ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!value) return null;
  if (value.length > 40 || !/^[\p{L}][\p{L}\p{M} '’ʼ-]*$/u.test(value))
    return null;
  return value;
}
/**
 * Безопасные шаблоны ПЕРВОЙ фразы преамбулы/реплики. Экспорт для WP4.
 * `kind` null/undefined — повод пропущен. Без подтверждённого имени
 * используется нейтральное домашнее обращение («солнышко»/«сонечко»/
 * «sweetheart»); невалидное имя молча заменяется им же. Строки ≤180 и
 * уже проходят валидатор обещаний; WP4 всё равно проверяет итоговый текст,
 * который взрослый мог отредактировать.
 */
export function storyOccasionLines(
  kind: StoryOccasionKind | null | undefined,
  locale: string,
  childName?: string | null,
): string[] {
  const lang: StoryLineLocale =
    locale === 'uk' || locale === 'en' ? locale : 'ru';
  const name = normalizeStoryChildName(childName) ?? DEFAULT_ADDRESS[lang];
  return LINES[lang][kind ?? 'none'].map((template) => {
    const line = template.replace('{name}', name);
    return line.charAt(0).toLocaleUpperCase(lang) + line.slice(1);
  });
}
export type StoryOccasion = {
  kind: StoryOccasionKind | null;
  /** Подпись: только для `other` (и наследия: свободное `occasion`). */
  label: string | null;
  theme: StoryTheme;
};
/**
 * Р-ST-WP3-3. Совместимость: старый клиент шлёт только `occasion` (свободная
 * подпись) — это `other` с этой подписью. Пресет без `other` подпись не
 * хранит (её показывает интерфейс по коду), `other` без подписи допустим.
 * Явная тема из запроса побеждает тему по поводу.
 */
export function resolveStoryOccasion(
  input: {
    occasionKind?: string | null;
    occasion?: string | null;
    theme?: string | null;
  },
  locale: string,
): StoryOccasion {
  const raw = (input.occasion ?? '')
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (raw.length > 80)
    throw new BadRequestException('Подпись повода — до 80 символов');
  let kind = (input.occasionKind ?? null) as StoryOccasionKind | null;
  if (kind && !STORY_OCCASION_KINDS.includes(kind))
    throw new BadRequestException('Неизвестный повод');
  if (!kind && raw) kind = 'other';
  const label = kind === 'other' && raw ? raw : null;
  if (label) assertStoryPromiseFree(label, locale);
  const theme = input.theme ?? storyOccasionTheme(kind);
  if (!STORY_THEMES.includes(theme as StoryTheme))
    throw new BadRequestException('Неизвестная тема оформления');
  return { kind, label, theme: theme as StoryTheme };
}
