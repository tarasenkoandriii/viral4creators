/**
 * Тексты покадровой озвучки и подписей обучалки по сайту клиента
 * (решение владельца 06.10.2026: «обучалки клиента сейчас немые —
 * озвучить по кадрам в этом же этапе»).
 *
 * Чистый модуль. Текст строится ТОЛЬКО из того, что уже есть в данных
 * черновика: шагов (`goto`/`fill`/`click`/маркер живого входа), раскладки
 * шагов по раундам (`stepsPerRound` — один раунд = один кадр), названия
 * обучалки и адреса сайта. Никакой модели: черновик одобряет оператор, и
 * звучать должно то, что он мог прочитать в шагах, а не пересказ.
 *
 * ## Что звучит на кадре
 *
 * Кадр i снят ПОСЛЕ раунда i. Зритель смотрит на экран и слышит, что на
 * нём сделать дальше, — то есть описание раунда i+1. Так же устроен
 * указатель сценарного пути: он показывает, куда нажмёт СЛЕДУЮЩИЙ шаг.
 * Первый кадр начинается с названия и адреса, последний — «Готово».
 *
 * ## Персональные данные
 *
 * ЗНАЧЕНИЯ полей не произносятся вовсе — ни логин, ни адрес, ни
 * телефон: шаг `fill` озвучивается названием поля. Всё, что всё-таки
 * попадает в текст (название обучалки, подписи полей из селекторов),
 * проходит `maskSensitiveEcho` (тот же фильтр, что у журналов
 * помощника) с подписями маски на языке озвучки: e-mail, телефоны и
 * длинные ряды цифр в речь не уходят.
 */

import {
  MaskLabels,
  maskSensitiveEcho,
} from '../../common/assist-chat-core/post-filter';
import { ScenarioStep } from '../tutorial-scenario/scenario-steps.types';

export const NARRATION_LOCALES = ['ru', 'uk', 'en', 'de', 'es'] as const;
export type NarrationLocale = (typeof NARRATION_LOCALES)[number];

/** Язык черновика; неизвестный и NULL (черновики до колонки) — русский,
 *  как всё прежнее поведение этого пути. */
export function narrationLocale(
  raw: string | null | undefined,
): NarrationLocale {
  const code = raw?.trim().toLowerCase().split(/[-_]/)[0];
  return (NARRATION_LOCALES as readonly string[]).includes(code ?? '')
    ? (code as NarrationLocale)
    : 'ru';
}

/** Потолок реплики — тот же, что у реплик сценарного пути (220
 *  символов, `MAX_NARRATION_LENGTH`): подпись влезает в кадр. */
export const CLIENT_NARRATION_MAX_LENGTH = 220;

/** Подпись поля длиннее — уже не подпись, а абзац. */
const LABEL_MAX_LENGTH = 40;

interface Phrases {
  open: (host: string) => string;
  fill: (labels: string[]) => string;
  fillUnnamed: string;
  click: (label: string) => string;
  clickUnnamed: string;
  login: string;
  done: string;
  mask: MaskLabels;
  quote: (s: string) => string;
}

const ru: Phrases = {
  open: (host) => `Откройте сайт ${host}.`,
  fill: (l) =>
    l.length === 1
      ? `Заполните поле ${ru.quote(l[0])}.`
      : `Заполните поля ${l.map(ru.quote).join(', ')}.`,
  fillUnnamed: 'Заполните поле.',
  click: (l) => `Нажмите ${ru.quote(l)}.`,
  clickUnnamed: 'Нажмите кнопку.',
  login: 'Войдите в личный кабинет.',
  done: 'Готово.',
  mask: { email: 'адрес почты', phone: 'номер телефона', token: 'ключ' },
  quote: (s) => `«${s}»`,
};

const uk: Phrases = {
  open: (host) => `Відкрийте сайт ${host}.`,
  fill: (l) =>
    l.length === 1
      ? `Заповніть поле ${uk.quote(l[0])}.`
      : `Заповніть поля ${l.map(uk.quote).join(', ')}.`,
  fillUnnamed: 'Заповніть поле.',
  click: (l) => `Натисніть ${uk.quote(l)}.`,
  clickUnnamed: 'Натисніть кнопку.',
  login: 'Увійдіть в особистий кабінет.',
  done: 'Готово.',
  mask: { email: 'адресу пошти', phone: 'номер телефону', token: 'ключ' },
  quote: (s) => `«${s}»`,
};

const en: Phrases = {
  open: (host) => `Open ${host}.`,
  fill: (l) =>
    l.length === 1
      ? `Fill in the ${en.quote(l[0])} field.`
      : `Fill in the fields ${l.map(en.quote).join(', ')}.`,
  fillUnnamed: 'Fill in the field.',
  click: (l) => `Click ${en.quote(l)}.`,
  clickUnnamed: 'Click the button.',
  login: 'Sign in to your account.',
  done: 'Done.',
  mask: { email: 'email address', phone: 'phone number', token: 'key' },
  quote: (s) => `“${s}”`,
};

const de: Phrases = {
  open: (host) => `Öffnen Sie ${host}.`,
  fill: (l) =>
    l.length === 1
      ? `Füllen Sie das Feld ${de.quote(l[0])} aus.`
      : `Füllen Sie die Felder ${l.map(de.quote).join(', ')} aus.`,
  fillUnnamed: 'Füllen Sie das Feld aus.',
  click: (l) => `Klicken Sie auf ${de.quote(l)}.`,
  clickUnnamed: 'Klicken Sie auf die Schaltfläche.',
  login: 'Melden Sie sich in Ihrem Konto an.',
  done: 'Fertig.',
  mask: { email: 'E-Mail-Adresse', phone: 'Telefonnummer', token: 'Schlüssel' },
  quote: (s) => `„${s}“`,
};

const es: Phrases = {
  open: (host) => `Abra ${host}.`,
  fill: (l) =>
    l.length === 1
      ? `Rellene el campo ${es.quote(l[0])}.`
      : `Rellene los campos ${l.map(es.quote).join(', ')}.`,
  fillUnnamed: 'Rellene el campo.',
  click: (l) => `Pulse ${es.quote(l)}.`,
  clickUnnamed: 'Pulse el botón.',
  login: 'Inicie sesión en su cuenta.',
  done: 'Listo.',
  mask: {
    email: 'correo electrónico',
    phone: 'número de teléfono',
    token: 'clave',
  },
  quote: (s) => `«${s}»`,
};

const PHRASES: Record<NarrationLocale, Phrases> = { ru, uk, en, de, es };

/**
 * Человеческое имя элемента из его селектора (§5.4: `#id` →
 * `[data-testid]` → `[name]` → `[aria-label]` → путь по тегам). Путь по
 * тегам и машинные id (`#f-8a3b9c`) имени не дают — `null`, и фраза
 * говорит «нажмите кнопку», а не читает вслух мусор.
 */
export function labelFromSelector(selector: string): string | null {
  const attr =
    /\[(aria-label|placeholder|name|data-testid|data-test|title)\s*[*^$|~]?=\s*(["'])(.*?)\2\s*\]/i.exec(
      selector,
    );
  let raw: string | null = null;
  let human = false;
  if (attr) {
    raw = attr[3];
    human = /^(aria-label|placeholder|title)$/i.test(attr[1]);
  } else {
    const id = /#([A-Za-z][\w-]*)/.exec(selector);
    if (id) raw = id[1];
  }
  if (!raw) return null;
  let label = raw;
  if (!human) {
    // `user_email`, `firstName`, `phone-number` → «user email», «first name».
    label = label
      .replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, '$1 $2')
      .replace(/[-_.:]+/g, ' ')
      .toLowerCase();
    // Машинный id: цифр много или есть «хвост-хеш» — не имя.
    if (/\d{3,}/.test(label) || /\b[a-f0-9]{6,}\b/.test(label)) return null;
  }
  label = label.replace(/\s+/g, ' ').trim();
  if (!label || label.length > LABEL_MAX_LENGTH) return null;
  return label;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.replace(/^www\./, '');
  } catch {
    return baseUrl;
  }
}

/** Описание одного раунда шагов (то, что делается на кадре ДО него). */
function describeRound(steps: readonly ScenarioStep[], p: Phrases): string {
  const parts: string[] = [];
  const fills: string[] = [];
  let unnamedFill = false;
  for (const step of steps) {
    if (step.kind === 'fill') {
      const label = labelFromSelector(step.selector);
      if (label) {
        if (!fills.includes(label)) fills.push(label);
      } else {
        unnamedFill = true;
      }
    }
  }
  if (fills.length > 0) parts.push(p.fill(fills));
  else if (unnamedFill) parts.push(p.fillUnnamed);
  for (const step of steps) {
    if (step.kind === 'click') {
      const label = labelFromSelector(step.selector);
      parts.push(label ? p.click(label) : p.clickUnnamed);
    } else if (step.kind === 'assertVisible') {
      // Маркер живого входа — единственный шаг своего раунда (§7.4.5).
      parts.push(p.login);
    } else if (step.kind === 'goto' && parts.length === 0) {
      parts.push(p.open(hostOf(step.route)));
    }
  }
  return parts.join(' ');
}

/**
 * `maskSensitiveEcho` плюс более широкий ряд цифр: фильтр помощника
 * пропускает телефон с двумя разделителями подряд («+7 (999) 123-45-67»),
 * а в речь он уйти не должен. Семь цифр и больше с любыми разделителями
 * между ними — «номер»; короткие числа («шаг 2», «100 ₽») не трогаются.
 */
export function maskPersonalData(text: string, labels: MaskLabels): string {
  return maskSensitiveEcho(text, labels).replace(
    /\+?\d(?:[\s().-]*\d){6,}/g,
    labels.phone,
  );
}

function clamp(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (Array.from(t).length <= CLIENT_NARRATION_MAX_LENGTH) return t;
  const cut = Array.from(t)
    .slice(0, CLIENT_NARRATION_MAX_LENGTH - 1)
    .join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
}

/**
 * Текст каждого кадра: длина массива = `frameCount`. `null` — кадру
 * нечего сказать (раунды разошлись с кадрами — тогда немы все, см.
 * ниже).
 *
 * Если число раундов не совпало с числом кадров, текстов нет ВОВСЕ: при
 * сдвиге на один раунд каждая фраза легла бы на чужой экран, а это хуже
 * немого ролика (тот же принцип «реплика не переносится на чужой кадр»,
 * что у спецификации темпа).
 */
export function clientFrameNarrations(input: {
  steps: readonly ScenarioStep[];
  stepsPerRound: readonly number[];
  frameCount: number;
  locale: NarrationLocale;
  title: string | null;
  baseUrl: string;
}): (string | null)[] {
  const n = input.frameCount;
  const p = PHRASES[input.locale];
  if (n <= 0) return [];
  const total = input.stepsPerRound.reduce((a, b) => a + b, 0);
  if (input.stepsPerRound.length !== n || total !== input.steps.length) {
    return Array.from({ length: n }, () => null);
  }
  const rounds: ScenarioStep[][] = [];
  let at = 0;
  for (const size of input.stepsPerRound) {
    rounds.push(input.steps.slice(at, at + size) as ScenarioStep[]);
    at += size;
  }
  return rounds.map((_, i) => {
    const pieces: string[] = [];
    if (i === 0) {
      const title = input.title?.trim();
      if (title) pieces.push(/[.!?…]$/.test(title) ? title : `${title}.`);
      pieces.push(p.open(hostOf(input.baseUrl)));
    }
    const next = rounds[i + 1];
    if (next) {
      const said = describeRound(next, p);
      if (said) pieces.push(said);
    } else {
      pieces.push(p.done);
    }
    const text = clamp(maskPersonalData(pieces.join(' '), p.mask));
    return text || null;
  });
}
