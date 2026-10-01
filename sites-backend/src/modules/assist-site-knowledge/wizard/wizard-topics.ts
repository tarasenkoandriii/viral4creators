/**
 * Наборы из 10 тем мастера по типу бизнеса (§4-тер.9 п.1) — ЧИСТЫЙ, W5.
 * Тексты вопросов — на языках кабинета uk/ru/en. Вопрос на языке базы
 * сайта становится вопросом проверенного ответа (FAQ) и запросом поиска
 * черновика: эмбеддинг многоязычен, а полнотекст и триграммы ищут слова
 * базы — поэтому язык вопроса выбирается по базе, а не по владельцу.
 */
import type {
  WizardAnswerTarget,
  WizardBusinessType,
  WizardTopic,
} from './wizard-types';

export interface WizardTopicDef {
  topic: WizardTopic;
  target: WizardAnswerTarget;
  question: Record<'uk' | 'ru' | 'en', string>;
  /** Запрос для поиска черновика по сайту (на языке базы — переводит модель). */
  searchHint: string;
}

export type WizardLang = 'uk' | 'ru' | 'en';

const T: Record<WizardTopic, Omit<WizardTopicDef, 'topic'>> = {
  delivery: {
    target: 'golden',
    question: {
      uk: 'Як ви доставляєте замовлення: способи, терміни, вартість?',
      ru: 'Как вы доставляете заказы: способы, сроки, стоимость?',
      en: 'How do you deliver orders: methods, timing, cost?',
    },
    searchHint: 'delivery shipping methods time cost',
  },
  payment: {
    target: 'golden',
    question: {
      uk: 'Які способи оплати ви приймаєте?',
      ru: 'Какие способы оплаты вы принимаете?',
      en: 'Which payment methods do you accept?',
    },
    searchHint: 'payment methods card cash on delivery',
  },
  returns: {
    target: 'golden',
    question: {
      uk: 'Які умови повернення та обміну?',
      ru: 'Какие условия возврата и обмена?',
      en: 'What are your return and exchange terms?',
    },
    searchHint: 'returns exchange refund terms',
  },
  warranty: {
    target: 'golden',
    question: {
      uk: 'Яка гарантія і як нею скористатися?',
      ru: 'Какая гарантия и как ею воспользоваться?',
      en: 'What warranty do you give and how does it work?',
    },
    searchHint: 'warranty guarantee service',
  },
  hours_contacts: {
    target: 'golden',
    question: {
      uk: 'Який у вас графік роботи і як з вами звʼязатися?',
      ru: 'Какой у вас график работы и как с вами связаться?',
      en: 'What are your working hours and how can customers contact you?',
    },
    searchHint: 'working hours contacts phone address',
  },
  availability: {
    target: 'golden',
    question: {
      uk: 'Як дізнатися, чи є товар у наявності?',
      ru: 'Как узнать, есть ли товар в наличии?',
      en: 'How can a customer check whether an item is in stock?',
    },
    searchHint: 'in stock availability',
  },
  wholesale_discounts: {
    target: 'golden',
    question: {
      uk: 'Чи є опт, знижки або акції? (Або «про знижки не говорити»)',
      ru: 'Есть ли опт, скидки или акции? (Или «о скидках не говорить»)',
      en: 'Do you offer wholesale, discounts or promotions? (Or “do not discuss discounts”)',
    },
    searchHint: 'wholesale discounts promotions',
  },
  must_not_promise: {
    target: 'persona_forbid',
    question: {
      uk: 'Що помічник НЕ повинен обіцяти клієнтам? (по одному на рядок)',
      ru: 'Что помощник НЕ должен обещать клиентам? (по одному в строке)',
      en: 'What must the assistant NOT promise customers? (one per line)',
    },
    searchHint: '',
  },
  handoff_when: {
    target: 'handoff_rule',
    question: {
      uk: 'Коли помічник має кликати людину? (по одному на рядок)',
      ru: 'Когда помощник должен звать человека? (по одному в строке)',
      en: 'When should the assistant call a human? (one per line)',
    },
    searchHint: '',
  },
  top_question: {
    target: 'golden',
    question: {
      uk: 'Яке найчастіше питання клієнтів і яка на нього відповідь?',
      ru: 'Какой самый частый вопрос клиентов и какой на него ответ?',
      en: 'What is the most frequent customer question, and the answer to it?',
    },
    searchHint: 'frequently asked questions FAQ',
  },
  booking: {
    target: 'golden',
    question: {
      uk: 'Як записатися або замовити послугу?',
      ru: 'Как записаться или заказать услугу?',
      en: 'How does a customer book or order a service?',
    },
    searchHint: 'booking appointment order service',
  },
  pricing: {
    target: 'golden',
    question: {
      uk: 'Скільки коштують ваші послуги або тарифи?',
      ru: 'Сколько стоят ваши услуги или тарифы?',
      en: 'How much do your services or plans cost?',
    },
    searchHint: 'prices pricing plans cost',
  },
  trial: {
    target: 'golden',
    question: {
      uk: 'Чи є пробний період або безкоштовний тариф?',
      ru: 'Есть ли пробный период или бесплатный тариф?',
      en: 'Is there a free trial or a free plan?',
    },
    searchHint: 'free trial free plan',
  },
  support: {
    target: 'golden',
    question: {
      uk: 'Як працює підтримка: канали, час відповіді?',
      ru: 'Как работает поддержка: каналы, время ответа?',
      en: 'How does support work: channels and response time?',
    },
    searchHint: 'customer support help response time',
  },
};

/** Магазин — ровно список §4-тер.9 п.1; услуги и SaaS — свои наборы. */
const SETS: Record<WizardBusinessType, readonly WizardTopic[]> = {
  shop: [
    'delivery',
    'payment',
    'returns',
    'warranty',
    'hours_contacts',
    'availability',
    'wholesale_discounts',
    'must_not_promise',
    'handoff_when',
    'top_question',
  ],
  services: [
    'booking',
    'pricing',
    'payment',
    'returns',
    'warranty',
    'hours_contacts',
    'wholesale_discounts',
    'must_not_promise',
    'handoff_when',
    'top_question',
  ],
  saas: [
    'pricing',
    'trial',
    'payment',
    'returns',
    'support',
    'hours_contacts',
    'wholesale_discounts',
    'must_not_promise',
    'handoff_when',
    'top_question',
  ],
};

/** Услуги и SaaS: «возврат» — отмена и возврат денег; «гарантия» — на работы. */
const OVERRIDES: Partial<
  Record<
    WizardBusinessType,
    Partial<Record<WizardTopic, Record<WizardLang, string>>>
  >
> = {
  services: {
    returns: {
      uk: 'Які умови скасування запису і повернення коштів?',
      ru: 'Какие условия отмены записи и возврата денег?',
      en: 'What are the cancellation and refund terms?',
    },
    warranty: {
      uk: 'Чи є гарантія на роботу?',
      ru: 'Есть ли гарантия на работу?',
      en: 'Do you guarantee your work?',
    },
  },
  saas: {
    returns: {
      uk: 'Як скасувати підписку і чи повертаєте ви гроші?',
      ru: 'Как отменить подписку и возвращаете ли вы деньги?',
      en: 'How can a subscription be cancelled, and do you refund?',
    },
    hours_contacts: {
      uk: 'Як з вами звʼязатися?',
      ru: 'Как с вами связаться?',
      en: 'How can customers contact you?',
    },
  },
};

export function wizardTopics(
  type: WizardBusinessType,
): readonly WizardTopicDef[] {
  return SETS[type].map((topic) => ({
    topic,
    ...T[topic],
    question: OVERRIDES[type]?.[topic] ?? T[topic].question,
  }));
}

/** Все темы (проверка параметра маршрута). */
export const ALL_WIZARD_TOPICS = Object.keys(T) as WizardTopic[];
