/**
 * Тексты страницы «Открыть приложение» (`/<локаль>/open`, Ш5 (6)).
 *
 * Зачем страница. Виджет ИИ-помощника платформы на лендинге даёт кнопки
 * только на страницы ЭТОГО сайта (фильтр ссылок платформы пускает лишь
 * подтверждённые хосты), поэтому прямой `t.me` действием виджета не
 * выдать. Действие «открыть приложение» (у старого консультанта —
 * `open-app`) ведёт сюда: страница лендинга, на которой две дороги в
 * продукт — «Открыть в Telegram» (`t.me/<бот>/app?startapp=e_ads`) и
 * браузер (`TMA_URL?entry=ads`), ровно те же, что у главной
 * (`lib/telegram-entry.ts`, `EntryActions`). Знания тенанта ссылаются на
 * неё документами `gen-open-<локаль>` (backend
 * `common/tutorial-knowledge/knowledge-sync.ts`, `OPEN_APP_PATH`).
 *
 * Тексты — здесь, а не в `dictionaries/*.json`: страница служебная
 * (`noindex`), её слова нужны только ей; подпись Telegram-кнопки — общая
 * (`dict.entryActions.telegramCta`).
 */
import type { Locale } from '../../../lib/i18n';

/** Сегмент адреса страницы — тот же, что `OPEN_APP_PATH` синхронизации знаний. */
export const OPEN_APP_SEGMENT = 'open';
/** Сценарий входа — главный (рекламный ролик), как у кнопок главной. */
export const OPEN_APP_ENTRY = 'ads' as const;

export interface OpenAppCopy {
  metaTitle: string;
  metaDescription: string;
  title: string;
  lead: string;
  browserCta: string;
  /** Подсказка, когда Telegram-кнопки нет (имя бота не задано). */
  browserOnlyHint: string;
  homeLink: string;
}

export const OPEN_APP_COPY: Record<Locale, OpenAppCopy> = {
  ru: {
    metaTitle: 'Открыть viral4creators',
    metaDescription: 'Откройте viral4creators в Telegram или в браузере.',
    title: 'Открыть viral4creators',
    lead: 'Один и тот же продукт работает как мини-апп в Telegram и как сайт в браузере — с одинаковыми возможностями. Устанавливать ничего не нужно.',
    browserCta: 'Открыть в браузере',
    browserOnlyHint: 'Продукт откроется в браузере — на любом устройстве.',
    homeLink: 'Что это за сервис',
  },
  uk: {
    metaTitle: 'Відкрити viral4creators',
    metaDescription: 'Відкрийте viral4creators у Telegram або в браузері.',
    title: 'Відкрити viral4creators',
    lead: 'Той самий продукт працює як міні-застосунок у Telegram і як сайт у браузері — з однаковими можливостями. Нічого встановлювати не потрібно.',
    browserCta: 'Відкрити в браузері',
    browserOnlyHint: 'Продукт відкриється в браузері — на будь-якому пристрої.',
    homeLink: 'Що це за сервіс',
  },
  en: {
    metaTitle: 'Open viral4creators',
    metaDescription: 'Open viral4creators in Telegram or in your browser.',
    title: 'Open viral4creators',
    lead: 'The same product works as a Telegram Mini App and as a website in your browser, with the same features. Nothing to install.',
    browserCta: 'Open in browser',
    browserOnlyHint: 'The product opens in your browser on any device.',
    homeLink: 'What is this service',
  },
  de: {
    metaTitle: 'viral4creators öffnen',
    metaDescription: 'Öffnen Sie viral4creators in Telegram oder im Browser.',
    title: 'viral4creators öffnen',
    lead: 'Dasselbe Produkt läuft als Telegram Mini App und als Website im Browser – mit denselben Funktionen. Installieren müssen Sie nichts.',
    browserCta: 'Im Browser öffnen',
    browserOnlyHint: 'Das Produkt öffnet sich im Browser – auf jedem Gerät.',
    homeLink: 'Was ist dieser Dienst',
  },
  es: {
    metaTitle: 'Abrir viral4creators',
    metaDescription: 'Abre viral4creators en Telegram o en el navegador.',
    title: 'Abrir viral4creators',
    lead: 'El mismo producto funciona como Mini App de Telegram y como sitio web en el navegador, con las mismas funciones. No hace falta instalar nada.',
    browserCta: 'Abrir en el navegador',
    browserOnlyHint: 'El producto se abre en el navegador, en cualquier dispositivo.',
    homeLink: 'Qué es este servicio',
  },
};
