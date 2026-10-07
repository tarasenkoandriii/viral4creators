/**
 * Знания гида → знания «Админки» тенанта viral4creators (Э-С Ш6).
 *
 * Один документ Markdown, собранный из ТЕХ ЖЕ источников, что промпт
 * советника: цели сценариев и карточки шагов (`hint-scenarios.ts`) и
 * формулировки фактов (`hint-facts.ts`) — второй копии текста нет, правка
 * карточки меняет и знания (и их штамп). Плюс то, чего у советника не было:
 * карта кнопок шагов (`data-assist-id`) для исполнителя интерфейса и
 * правила «никогда».
 *
 * Знания о продукте «снаружи» (корпус лендинга) сюда НЕ входят: после Ш5
 * они живут в режиме «Сайт» того же тенанта, и в «Админку» их подключает
 * переключатель «сотрудникам тоже публичный сайт» (`includePublicInAdmin`)
 * — второй копии корпуса в «Админке» не нужно (решение Р-Ш6-6).
 *
 * Отдаётся `GET /guide-assist/v1/knowledge.md` (без авторизации: внутри
 * только описание мастера, никаких данных пользователей; но лишь когда
 * задан ключ коннектора `WIZARD_GUIDE_ASSIST_CONNECTOR_KEY`, иначе 404) —
 * владелец добавляет его в «Знания (сотрудники)» файлом или ссылкой.
 *
 * Чистый модуль.
 */
import { createHash } from 'crypto';
import type { FreeScenario } from '../../common/test-user-scenarios';
import { SCENARIO_HINTS } from '../wizard-guide/hint-scenarios';
import {
  clientSiteFacts,
  greetingFacts,
  productFacts,
} from '../wizard-guide/hint-facts';
import { SCENARIO_TITLES, stepsOf } from './guide-assist-facts';

/**
 * Чего помощник в TMA не делает НИКОГДА — и почему. Разметка
 * `data-assist="never"` на этих кнопках в TMA (Ш6, Р-Ш6-3, Р-Ш6-11) —
 * первая линия, стоп-слова «Админки» (`ADMIN_NEVER_WORDS`) — вторая; этот
 * текст — чтобы модель и не предлагала. Обратная проверка разметки —
 * `frontend/scripts/guide-assist.test.ts` (каждый вызов платной/опасной
 * функции TMA ведёт к размеченной кнопке).
 */
export const GUIDE_NEVER_RULES: readonly string[] = [
  'Оплата: покупка, смена или отмена тарифа, подписка, пакеты кредитов, Telegram Stars, WayForPay — человек нажимает сам.',
  'Удаление: проекты, бренды, голоса, персона, образы, записанные кадры, эскизы, тестовые аккаунты — человек нажимает сам.',
  'Запуск и повтор рендера списывают кредиты (в том числе пакетный рендер каталога, экспорт в форматы, перерендер, переозвучка и A/B-тест) — помощник подводит к кнопке, нажимает человек.',
  'Согласия — оферта, съёмка персоны, лицо на фото поздравления, клон голоса, вход в аккаунт сайта для обучалки, рассылка — человек отмечает и подтверждает сам.',
  'Выпуск и отзыв API-ключей, отключение каналов публикации, отзыв публикации — только человек.',
  'Подтверждение в диалоге «Удалить» и любые кнопки внутри такого диалога — только человек.',
  'Ввод паролей, платёжных данных и входа на чужой сайт — только человек.',
];

/**
 * Разовые платные действия, которые человек сам попросил голосом или
 * текстом (Р-Ш6-11): помощник нажимает только после карточки
 * подтверждения — разметка `data-assist="confirm"` в TMA.
 */
export const GUIDE_CONFIRM_RULES: readonly string[] = [
  'Только по просьбе человека и после его «Да» в карточке подтверждения: генерация сценария (и смена режима озвучки, которая его пересобирает), кадр-референс и подсказка настроек сцены поздравления, эскиз, новая база или новый образ персоны, проверка персоны, превью персонажа, звуковая дорожка на одном языке, проба голоса, разбор ролика-образца, проверка ролика, звука и релевантности, исправление по проверке.',
  'Так же — отправка публикации на модерацию, отправка обучалки на сборку и шаги записи обучалки по сайту (каждый шаг расходует лимит).',
  'В карточке подтверждения назовите цену, списание кредитов или остаток лимита, если они видны на экране; если не видны — скажите, что действие платное или расходует лимит.',
  'Не запускайте такие действия сами «заодно» — только то, что человек попросил сейчас.',
];

/** Все формулировки фактов — из кода советника (обе полярности). */
export function factGlossary(): Record<FreeScenario, string[]> {
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    CLIENT_SITE: uniq([
      ...clientSiteFacts(null),
      ...clientSiteFacts({
        rounds: 0,
        title: null,
        status: 'DRAFTING',
        hasCredentials: false,
        requiresLiveLoginReplay: false,
      }),
      ...clientSiteFacts({
        rounds: 3,
        title: 'x',
        status: 'SUBMITTED',
        hasCredentials: true,
        requiresLiveLoginReplay: true,
      }),
    ]).map((f) => f.replace(/\d+/g, 'N')),
    GREETING_VIDEO: uniq([
      ...greetingFacts(null),
      ...greetingFacts({
        occasion: null,
        customOccasionText: null,
        recipientName: null,
        senderName: null,
        usesAvatar: false,
        referenceImages: 0,
        hasPrompt: false,
        promptFlagged: false,
        hasVideo: false,
      }),
      ...greetingFacts({
        occasion: 'OTHER',
        customOccasionText: 'x',
        recipientName: 'x',
        senderName: 'x',
        usesAvatar: true,
        referenceImages: 2,
        hasPrompt: true,
        promptFlagged: true,
        hasVideo: true,
      }),
    ]).map((f) => f.replace(/\d+/g, 'N')),
    PRODUCT_VIDEO: uniq([
      ...productFacts(null),
      ...productFacts({
        hasReference: false,
        analysisComplete: false,
        onSceneTemplate: false,
        hasProductInfo: false,
        hasProductImage: false,
        promptApproved: false,
        renderInFlight: false,
        hasVideo: false,
      }),
      ...productFacts({
        hasReference: true,
        analysisComplete: true,
        onSceneTemplate: true,
        hasProductInfo: true,
        hasProductImage: true,
        promptApproved: true,
        renderInFlight: true,
        hasVideo: true,
      }),
    ]),
  };
}

const ORDER: readonly FreeScenario[] = [
  'PRODUCT_VIDEO',
  'GREETING_VIDEO',
  'CLIENT_SITE',
];

export function buildGuideKnowledge(): string {
  const glossary = factGlossary();
  const out: string[] = [
    '# Мастер Viral4Creators — знания помощника пользователя',
    '',
    'Помощник работает внутри мини-аппа Viral4Creators в Telegram. Пользователь мини-аппа делает ролики: рекламу товара по образцу, видеопоздравление или обучающий ролик по своему сайту. Помощник отвечает на вопросы о шагах мастера, рассказывает, что уже сделано в проекте, и может сам перейти на нужный шаг или заполнить поле — на глазах у человека.',
    '',
    '## Как помощник узнаёт состояние проекта',
    '',
    'Через API «Viral4Creators — факты мастера»: `listProjects` — проекты пользователя (без названий, по номеру, сценарию и давности), `getProjectFacts` — шаги и факты состояния проекта словами, `getAccountSummary` — тариф. Значения полей (имена, тексты, названия) помощнику не передаются: если человек спрашивает, что именно он написал, попросите посмотреть на экран.',
    '',
    '## Никогда',
    '',
    ...GUIDE_NEVER_RULES.map((r) => `- ${r}`),
    '',
    '## Только с подтверждением',
    '',
    ...GUIDE_CONFIRM_RULES.map((r) => `- ${r}`),
    '',
  ];
  for (const scenario of ORDER) {
    const hints = SCENARIO_HINTS[scenario];
    if (!hints) continue;
    out.push(`## Сценарий: ${SCENARIO_TITLES[scenario]}`, '');
    out.push(`Цель: ${hints.goal}.`, '');
    out.push('Шаги мастера (по порядку):', '');
    for (const s of stepsOf(scenario)) {
      out.push(
        `- **${s.id}** — ${s.goal} Кнопка шага в степпере: \`${s.uiTarget}\`.`,
      );
    }
    out.push('', 'Возможные факты состояния:', '');
    for (const f of glossary[scenario]) out.push(`- ${f}`);
    out.push('');
  }
  return out.join('\n');
}

/** Штамп знаний — меняется с любой карточкой, фактом или правилом. */
export function guideKnowledgeStamp(): string {
  return createHash('sha256')
    .update(buildGuideKnowledge())
    .digest('hex')
    .slice(0, 12);
}
