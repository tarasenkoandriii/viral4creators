/**
 * Ответы без модели (ТЗ §4.5 «правила без модели», §4.8, §4.13 п.6) и их
 * распознавание — W3, чистый модуль. Тексты — посетителю, на языке
 * вопроса (uk/ru/en, §3.5); подписи кнопок — короткие (≤ 60, §4.9).
 */
import { questionLang } from '../assist-knowledge-core/answer/prompt';
import { normalizeQuestion } from '../assist-knowledge-core/semantic-cache-key';
import type { SiteAction } from './chat-types';

export type ChatLang = 'uk' | 'ru' | 'en';

/** Украинские слова без «і/ї/є/ґ» («Дякую», «що», «чи») — для коротких фраз. */
const UK_WORDS =
  /(?:^|[^\p{L}])(?:дякую|будь ласка|що|чи|де|коли|та|це|вже|зараз|тепер|якщо|бо)(?=$|[^\p{L}])/iu;

/** Язык ответа: язык вопроса; короткое «привет» — подсказка интерфейса. */
export function answerLangOf(
  question: string,
  uiLang: string | null,
): ChatLang {
  const hint = uiLang?.slice(0, 2).toLowerCase() ?? null;
  const lang = questionLang(question, hint);
  if (lang === 'ru' && !/[ыэёъ]/i.test(question) && UK_WORDS.test(question)) {
    return 'uk';
  }
  return lang;
}

export type TemplateKind =
  | 'greeting'
  | 'thanks'
  | 'handoff'
  | 'disabled'
  | 'site_quota'
  | 'platform_budget'
  | 'no_knowledge'
  | 'injection'
  | 'suspicious'
  | 'partial'
  | 'visitor_limit';

export const TEMPLATE_TEXT: Record<TemplateKind, Record<ChatLang, string>> = {
  greeting: {
    uk: 'Вітаю! Я ШІ-помічник сайту. Запитайте про товари, доставку, оплату чи умови — відповім за сторінками сайту.',
    ru: 'Здравствуйте! Я ИИ-помощник сайта. Спросите о товарах, доставке, оплате или условиях — отвечу по страницам сайта.',
    en: "Hello! I'm the site's AI assistant. Ask about products, delivery, payment or terms — I'll answer from the site's pages.",
  },
  thanks: {
    uk: 'Будь ласка! Якщо будуть ще питання — пишіть.',
    ru: 'Пожалуйста! Если появятся ещё вопросы — пишите.',
    en: "You're welcome! Ask me anything else about the site.",
  },
  handoff: {
    uk: 'Залиште, будь ласка, контакти — менеджер звʼяжеться з вами.',
    ru: 'Оставьте, пожалуйста, контакты — менеджер свяжется с вами.',
    en: 'Please leave your contact details — a manager will get back to you.',
  },
  disabled: {
    uk: 'Помічник зараз не відповідає. Залиште заявку — вам відповість менеджер.',
    ru: 'Помощник сейчас не отвечает. Оставьте заявку — вам ответит менеджер.',
    en: 'The assistant is unavailable right now. Leave a request and a manager will reply.',
  },
  site_quota: {
    uk: 'Помічник тимчасово не може відповісти. Залиште заявку — менеджер звʼяжеться з вами.',
    ru: 'Помощник временно не может ответить. Оставьте заявку — менеджер свяжется с вами.',
    en: "The assistant can't answer right now. Leave a request and a manager will contact you.",
  },
  platform_budget: {
    uk: 'Сервіс помічника перевантажений. Залиште заявку — менеджер відповість.',
    ru: 'Сервис помощника перегружен. Оставьте заявку — менеджер ответит.',
    en: 'The assistant service is overloaded. Leave a request and a manager will reply.',
  },
  no_knowledge: {
    uk: 'На жаль, на сторінках сайту я не знайшов відповіді на це питання. Залиште заявку — менеджер уточнить.',
    ru: 'К сожалению, на страницах сайта я не нашёл ответа на этот вопрос. Оставьте заявку — менеджер уточнит.',
    en: "Sorry, I couldn't find the answer on the site's pages. Leave a request and a manager will clarify.",
  },
  injection: {
    uk: 'Я відповідаю лише на питання про цей сайт за його сторінками. Що вас цікавить?',
    ru: 'Я отвечаю только на вопросы об этом сайте по его страницам. Что вас интересует?',
    en: 'I only answer questions about this site based on its pages. What would you like to know?',
  },
  suspicious: {
    uk: 'Зараз я не можу відповісти на це питання. Залиште заявку — менеджер звʼяжеться з вами.',
    ru: 'Сейчас я не могу ответить на этот вопрос. Оставьте заявку — менеджер свяжется с вами.',
    en: "I can't answer this question right now. Leave a request and a manager will contact you.",
  },
  partial: {
    uk: 'Відповідь перервалася — повторити?',
    ru: 'Ответ прервался — повторить?',
    en: 'The answer was interrupted — try again?',
  },
  visitor_limit: {
    uk: 'Забагато повідомлень. Залиште заявку — менеджер відповість.',
    ru: 'Слишком много сообщений. Оставьте заявку — менеджер ответит.',
    en: 'Too many messages. Leave a request and a manager will reply.',
  },
};

export const LEAD_LABEL: Record<ChatLang, string> = {
  uk: 'Залишити заявку',
  ru: 'Оставить заявку',
  en: 'Leave a request',
};

/** Оговорка §4-тер.10: знания на другом языке. */
export const KNOWLEDGE_LANG_NOTE: Record<ChatLang, Record<string, string>> = {
  uk: { uk: 'українською', ru: 'російською', en: 'англійською' },
  ru: { uk: 'на украинском', ru: 'на русском', en: 'на английском' },
  en: { uk: 'in Ukrainian', ru: 'in Russian', en: 'in English' },
};

export function leadAction(lang: ChatLang): SiteAction {
  return { kind: 'lead', label: LEAD_LABEL[lang] };
}

const GREETING = new Set([
  'привет',
  'здравствуйте',
  'здравствуй',
  'добрый день',
  'добрый вечер',
  'доброе утро',
  'привіт',
  'вітаю',
  'добрий день',
  'добрий вечір',
  'доброго дня',
  'добрий ранок',
  'hi',
  'hello',
  'hey',
  'good morning',
  'good afternoon',
  'good evening',
  'хай',
  'салют',
]);
const THANKS = new Set([
  'спасибо',
  'спасибо большое',
  'благодарю',
  'дякую',
  'дуже дякую',
  'thanks',
  'thank you',
  'thank you very much',
  'thx',
  'спс',
  'ок спасибо',
  'ок, спасибо',
  'ок дякую',
]);
/** «Позовите человека» — короткий запрос без другой темы (§4.5 правило 1). */
const HANDOFF =
  /^(?:(?:позовите|позови|позовіть|покличте|поклич|соедините с|зʼєднайте з|з'єднайте з|переключите на|переключіть на|хочу поговорить с|хочу поговорити з|нужен|нужна|потрібен|потрібна|дайте|call|connect me (?:to|with)|i want to talk to|let me talk to|i need)\s+)?(?:a\s+|an\s+)?(?:живого\s+|живу\s+|живий\s+|real\s+|live\s+)?(?:человека|человек|оператора|оператор|менеджера|менеджер|консультанта|людину|людина|human|person|operator|manager|agent)(?:\s+(?:пожалуйста|будь ласка|please))?$/u;

export type PreModelRule = 'greeting' | 'thanks' | 'handoff' | null;

/** Правила без модели по НОРМАЛИЗОВАННОМУ вопросу (приветствие/спасибо/человек). */
export function preModelRule(question: string): PreModelRule {
  const q = normalizeQuestion(question)
    .replace(/[!.,?…)(]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!q || q.length > 60) return null;
  if (GREETING.has(q)) return 'greeting';
  if (THANKS.has(q)) return 'thanks';
  if (HANDOFF.test(q)) return 'handoff';
  return null;
}
