/**
 * Сборка базы знаний ИИ-консультанта на лендинге
 * (doc/LANDING-TUTORIAL-AI-CONSULTANT-SPEC.md §5.2). Запускается в
 * `prebuild` (`ts-node scripts/build-assistant-knowledge.ts`) — те же
 * данные, что видит посетитель (шаги обучалки, FAQ, тарифы, лимиты
 * пайплайна), собираются из уже существующих источников, а не
 * переписываются вручную: ручная копия расходится с продуктом (это уже
 * случилось с FAQ — там был текст «единственный движок Veo», хотя Grok
 * добавлен позже).
 *
 * Результат — ДВА артефакта, оба коммитятся:
 *  1. `knowledge/<locale>.md` — читаемый markdown, ради diff в PR и
 *     ручного ревью (§5.2: «файл базы можно прочитать целиком»).
 *  2. `knowledge/generated.ts` — тот же текст плюс проактивные подсказки
 *     (§6.6.2), обёрнутые в TS-константы. Раздельно от .md, потому что
 *     рантайм (serverless-функция на Vercel) не должен читать файлы с
 *     диска по относительному пути — тот путь ломается между `src` и
 *     `dist`; `.ts`-модуль читается обычным `import`, как любой другой
 *     код, без вопроса «а где мы сейчас на файловой системе».
 *
 * Источники: пять локалей лендинга (`landing/src/dictionaries`) и
 * мини-аппа (`frontend/src/dictionaries`), константы бэкенда
 * (`common/plans.ts` и соседние). Никакой сети и базы — чистая функция
 * от файлов репозитория, поэтому исполняется и в песочнице разработки
 * без доступа к Postgres (см. doc/CI.md).
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  PLANS,
  PLAN_IDS,
  NATIVE_ASPECT_RATIOS,
  type PlanFeature,
} from '../src/common/plans';
import {
  VEO_MAX_SECONDS,
  VEO_MAX_CALLS,
  GROK_MAX_SECONDS,
  GROK_MAX_BASE_SECONDS,
  GROK_MAX_EXTEND_SECONDS,
} from '../src/common/video-extension-plan';
import { VIDEO_DURATION_SECONDS } from '../src/common/veo-duration';
import {
  VOICE_MODES,
  VOICE_MODE_LABEL,
  DEFAULT_VOICE_MODE,
} from '../src/common/voice-mode';
import { MAX_PHOTO_BYTES } from '../src/common/photo-limits';
import {
  subscriptionPriceFor,
  creditPacks,
} from '../src/common/billing-pricing';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LANDING_DICT_DIR = path.join(REPO_ROOT, 'landing', 'src', 'dictionaries');
const FRONTEND_DICT_DIR = path.join(
  REPO_ROOT,
  'frontend',
  'src',
  'dictionaries',
);
const OUT_DIR = path.join(
  __dirname,
  '..',
  'src',
  'modules',
  'assistant',
  'knowledge',
);

export const LOCALES = ['ru', 'uk', 'en', 'de', 'es'] as const;
export type Locale = (typeof LOCALES)[number];

const PLANS_BILLING_ENABLED = process.env.PLANS_BILLING_ENABLED === 'true';

// Соответствует спискам allow-list §5.2 п.5 — только то, на что реально
// отвечает консультант; словарь мини-аппа большой и содержит тексты
// ошибок, которые сюда не нужны.
const WIZARD_HINT_ALLOWLIST: Array<{ path: string[]; label: string }> = [
  { path: ['videoUpload', 'hint'], label: 'Загрузка референса' },
  { path: ['videoUpload', 'fileHint'], label: 'Файл референса' },
  {
    path: ['videoUpload', 'tooLarge'],
    label: 'Референс — файл слишком большой',
  },
  {
    path: ['brandSnapshotEditor', 'voiceHint'],
    label: 'Манифест бренда — голос',
  },
  {
    path: ['brandSnapshotEditor', 'hintDefault'],
    label: 'Манифест бренда — по умолчанию',
  },
  { path: ['myVoices', 'limitReached'], label: 'Клонирование голоса — лимит' },
];

function readJson(dir: string, locale: Locale): Record<string, unknown> {
  const p = path.join(dir, `${locale}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readManual(locale: Locale): string {
  const p = path.join(OUT_DIR, `manual.${locale}.md`);
  return fs.readFileSync(p, 'utf8').trim();
}

function get(obj: unknown, segments: string[]): unknown {
  return segments.reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object')
      return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

const SECTION_TITLE: Record<Locale, Record<string, string>> = {
  ru: {
    header: 'База знаний ИИ-консультанта viral4creators',
    steps: 'Шаги обучалки',
    faq: 'Частые вопросы',
    plans: 'Тарифы и возможности',
    pipeline: 'Правила пайплайна',
    hints: 'Подсказки полей мастера',
    manual: 'Дополнительно',
    billingOff:
      'Все тарифы сейчас бесплатны и переключаются пользователем самостоятельно в мини-аппе (это временный период обкатки продукта, оплата ещё не включена).',
    billingOn:
      'Смена тарифа — платная подписка; цены см. в разделе «Тарифы» ниже.',
    availableFrom: 'доступно с тарифа',
  },
  uk: {
    header: 'База знань ІІ-консультанта viral4creators',
    steps: 'Кроки навчалки',
    faq: 'Часті запитання',
    plans: 'Тарифи та можливості',
    pipeline: 'Правила пайплайну',
    hints: 'Підказки полів майстра',
    manual: 'Додатково',
    billingOff:
      'Усі тарифи зараз безкоштовні й перемикаються користувачем самостійно в міні-застосунку (це тимчасовий період обкатки продукту, оплата ще не увімкнена).',
    billingOn:
      'Зміна тарифу — платна підписка; ціни див. у розділі «Тарифи» нижче.',
    availableFrom: 'доступно з тарифу',
  },
  en: {
    header: 'viral4creators AI consultant knowledge base',
    steps: 'Tutorial steps',
    faq: 'Frequently asked questions',
    plans: 'Plans and features',
    pipeline: 'Pipeline rules',
    hints: 'Wizard field hints',
    manual: 'Additional notes',
    billingOff:
      'All plans are currently free and switched by the user themselves in the mini-app (this is a temporary trial period, billing is not enabled yet).',
    billingOn:
      'Switching plans is a paid subscription; see the "Plans" section below for prices.',
    availableFrom: 'available from plan',
  },
  de: {
    header: 'Wissensdatenbank des viral4creators-KI-Beraters',
    steps: 'Anleitungsschritte',
    faq: 'Häufige Fragen',
    plans: 'Tarife und Funktionen',
    pipeline: 'Pipeline-Regeln',
    hints: 'Hinweise zu Assistentenfeldern',
    manual: 'Zusätzliches',
    billingOff:
      'Alle Tarife sind derzeit kostenlos und werden vom Nutzer selbst in der Mini-App umgeschaltet (dies ist eine vorübergehende Testphase, die Abrechnung ist noch nicht aktiviert).',
    billingOn:
      'Der Tarifwechsel ist ein kostenpflichtiges Abonnement; Preise siehe Abschnitt „Tarife“ unten.',
    availableFrom: 'verfügbar ab Tarif',
  },
  es: {
    header: 'Base de conocimiento del consultor de IA de viral4creators',
    steps: 'Pasos del tutorial',
    faq: 'Preguntas frecuentes',
    plans: 'Planes y funciones',
    pipeline: 'Reglas del pipeline',
    hints: 'Sugerencias de los campos del asistente',
    manual: 'Notas adicionales',
    billingOff:
      'Todos los planes son gratuitos por ahora y el propio usuario los cambia en la mini-app (es un período de prueba temporal, la facturación aún no está activada).',
    billingOn:
      'Cambiar de plan es una suscripción de pago; ver precios en la sección "Planes" más abajo.',
    availableFrom: 'disponible desde el plan',
  },
};

function buildKnowledge(locale: Locale): string {
  const landingDict = readJson(LANDING_DICT_DIR, locale);
  const frontendDict = readJson(FRONTEND_DICT_DIR, locale);
  const t = SECTION_TITLE[locale];
  const lines: string[] = [];

  lines.push(`# ${t.header}`);
  lines.push('');
  lines.push(
    `_Собрано автоматически ${new Date().toISOString().slice(0, 10)} из lending/frontend/backend; коммит — ${process.env.VERCEL_GIT_COMMIT_SHA ?? 'local'}._`,
  );
  lines.push('');

  // ── Шаги обучалки ──────────────────────────────────────────────────
  lines.push(`## ${t.steps}`);
  const steps = get(landingDict, ['steps', 'items']) as Array<{
    title: string;
    text: string;
    details?: string[];
    badge?: string;
  }>;
  const badgeLabels = get(landingDict, ['steps', 'badges']) as Record<
    string,
    string
  >;
  steps.forEach((step, i) => {
    lines.push('');
    lines.push(`### ${i + 1}. ${step.title}`);
    lines.push(step.text);
    if (step.badge && badgeLabels?.[step.badge]) {
      lines.push(`(${t.availableFrom}: ${badgeLabels[step.badge]})`);
    }
    if (step.details?.length) {
      for (const d of step.details) lines.push(`- ${d}`);
    }
  });
  lines.push('');

  // ── FAQ ────────────────────────────────────────────────────────────
  lines.push(`## ${t.faq}`);
  const faqItems = get(landingDict, ['faq', 'items']) as Array<{
    question: string;
    answer: string;
  }>;
  for (const item of faqItems) {
    lines.push('');
    lines.push(`**${item.question}**`);
    lines.push(item.answer);
  }
  lines.push('');

  // ── Тарифы и возможности ───────────────────────────────────────────
  lines.push(`## ${t.plans}`);
  lines.push('');
  lines.push(PLANS_BILLING_ENABLED ? t.billingOn : t.billingOff);
  const featureLabels = get(frontendDict, [
    'planScreen',
    'featureLabels',
  ]) as Record<string, string>;
  for (const planId of PLAN_IDS) {
    const plan = PLANS[planId];
    lines.push('');
    lines.push(`### ${plan.title}`);
    lines.push(plan.summary);
    const included = (Object.keys(plan.features) as PlanFeature[]).filter(
      (f) => plan.features[f] && f !== 'avatarLipsync',
    );
    if (included.length) {
      lines.push(included.map((f) => featureLabels?.[f] ?? f).join(', '));
    }
    lines.push(
      plan.aspectRatios.length
        ? `${plan.aspectRatios.join('/')} only`
        : 'any aspect ratio',
    );
    if (PLANS_BILLING_ENABLED && planId !== 'LITE') {
      const price = subscriptionPriceFor(planId as 'STANDARD' | 'PREMIUM');
      lines.push(
        `${price.stars} Stars / ${(price.wayforpayMinor / 100).toFixed(0)} ${price.wayforpayCurrency}`,
      );
    }
  }
  if (PLANS_BILLING_ENABLED) {
    const packs = creditPacks(locale);
    if (packs.length) {
      lines.push('');
      lines.push(
        packs
          .map(
            (p) =>
              `${p.title}: ${p.credits} — ${p.stars} Stars / ${(p.wayforpayMinor / 100).toFixed(0)} ${p.wayforpayCurrency}`,
          )
          .join('; '),
      );
    }
  }
  lines.push('');

  // ── Правила пайплайна ──────────────────────────────────────────────
  lines.push(`## ${t.pipeline}`);
  lines.push('');
  lines.push(
    `Veo: до ${VIDEO_DURATION_SECONDS} секунд за вызов, до ${VEO_MAX_CALLS} вызовов, максимум ${VEO_MAX_SECONDS} секунд суммарно.`,
  );
  lines.push(
    `Grok: базовый ролик до ${GROK_MAX_BASE_SECONDS} секунд плюс одно расширение до ${GROK_MAX_EXTEND_SECONDS} секунд, максимум ${GROK_MAX_SECONDS} секунд. Разрешение до 1080p, при референс-изображениях или расширении — до 720p.`,
  );
  lines.push(
    `Референс — поиск по YouTube, ссылка или свой файл (лимит — см. интерфейс загрузки, ориентир 100 МБ); на Premium — библиотека готовых разборов без нового вызова ИИ.`,
  );
  lines.push(
    `Озвучка — три режима: ${VOICE_MODES.map((m) => VOICE_MODE_LABEL[m]).join(', ')}; по умолчанию — «${VOICE_MODE_LABEL[DEFAULT_VOICE_MODE]}».`,
  );
  lines.push(
    `Форматы кадра: ${NATIVE_ASPECT_RATIOS.join(' и ')} доступны на всех тарифах; остальные — от Standard.`,
  );
  lines.push(
    `Фото товара — до ${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))} МБ.`,
  );
  lines.push('');

  // ── Подсказки полей мастера ────────────────────────────────────────
  lines.push(`## ${t.hints}`);
  for (const { path: p, label } of WIZARD_HINT_ALLOWLIST) {
    const value = get(frontendDict, p);
    if (typeof value === 'string' && value.trim()) {
      lines.push('');
      lines.push(`**${label}**: ${value}`);
    }
  }
  lines.push('');

  // ── Ручной слой ────────────────────────────────────────────────────
  lines.push(`## ${t.manual}`);
  lines.push('');
  lines.push(readManual(locale));
  lines.push('');

  return lines.join('\n');
}

// ── Проактивные подсказки (§6.6.2) — заготовленный текст, не вызов
// модели; переводится вручную вместе с этим скриптом. ─────────────────
interface ProactiveTips {
  step: Record<string, string>;
  plans: string;
  exitIntent: string;
}

// Три подсказки-вопроса для пустой панели (§4.3, §6.1) — не проактивный
// сигнал (§6.6), а стартовые кнопки, которые видит любой посетитель,
// открывший панель сам. Тот же принцип, что и `PROACTIVE_TIPS` ниже:
// заготовленный текст, переводится вручную вместе со скриптом.
export const SUGGESTED_QUESTIONS: Record<Locale, string[]> = {
  ru: [
    'У меня косметика, а референс — про кроссовки, сработает?',
    'Что будет, если у товара нет фото?',
    'Сколько будет стоить 25-секундный ролик?',
  ],
  uk: [
    'У мене косметика, а референс — про кросівки, спрацює?',
    'Що буде, якщо у товару немає фото?',
    'Скільки коштуватиме 25-секундний ролик?',
  ],
  en: [
    'I sell cosmetics, but the reference is about sneakers — will it work?',
    'What happens if my product has no photo?',
    'How much would a 25-second video cost?',
  ],
  de: [
    'Ich verkaufe Kosmetik, aber die Referenz zeigt Sneaker — funktioniert das?',
    'Was passiert, wenn mein Produkt kein Foto hat?',
    'Was würde ein 25-sekündiges Video kosten?',
  ],
  es: [
    'Vendo cosmética, pero la referencia es de zapatillas, ¿funcionará?',
    '¿Qué pasa si mi producto no tiene foto?',
    '¿Cuánto costaría un video de 25 segundos?',
  ],
};

export const PROACTIVE_TIPS: Record<Locale, ProactiveTips> = {
  ru: {
    step: {
      '2': 'Не понятно, что вводить на шаге «Выберите референс»? Спросите',
      '4': 'Не понятно, что делает проверка релевантности? Спросите',
      '5': 'Не понятно, как собрать состав кадра? Спросите',
      '7': 'Не понятно, какой формат выбрать? Спросите',
      '9': 'Не получилось с первого раза? Спросите, что можно поправить',
    },
    plans: 'Сомневаетесь, какой тариф нужен для вашей задачи? Опишите её',
    exitIntent: 'Если не нашли ответ — спросите, это быстрее, чем в Telegram',
  },
  uk: {
    step: {
      '2': 'Не зрозуміло, що вводити на кроці «Оберіть референс»? Запитайте',
      '4': 'Не зрозуміло, що робить перевірка релевантності? Запитайте',
      '5': 'Не зрозуміло, як зібрати склад кадру? Запитайте',
      '7': 'Не зрозуміло, який формат обрати? Запитайте',
      '9': 'Не вийшло з першого разу? Запитайте, що можна виправити',
    },
    plans:
      'Сумніваєтеся, який тариф потрібен для вашого завдання? Опишіть його',
    exitIntent:
      'Якщо не знайшли відповідь — запитайте, це швидше, ніж у Telegram',
  },
  en: {
    step: {
      '2': 'Not sure what to enter at the "Choose a reference" step? Ask',
      '4': 'Not sure what the relevance check does? Ask',
      '5': 'Not sure how to put the frame together? Ask',
      '7': 'Not sure which aspect ratio to pick? Ask',
      '9': "Didn't work on the first try? Ask what to fix",
    },
    plans: 'Not sure which plan fits your case? Describe it',
    exitIntent:
      "If you haven't found the answer — just ask, it's faster than Telegram",
  },
  de: {
    step: {
      '2': 'Unklar, was bei „Referenz wählen“ einzugeben ist? Fragen Sie',
      '4': 'Unklar, was die Relevanzprüfung macht? Fragen Sie',
      '5': 'Unklar, wie die Bildkomposition zusammengestellt wird? Fragen Sie',
      '7': 'Unklar, welches Format Sie wählen sollen? Fragen Sie',
      '9': 'Beim ersten Versuch nicht geklappt? Fragen Sie, was zu ändern ist',
    },
    plans:
      'Unsicher, welcher Tarif zu Ihrer Aufgabe passt? Beschreiben Sie sie',
    exitIntent:
      'Keine Antwort gefunden? Einfach fragen — schneller als Telegram',
  },
  es: {
    step: {
      '2': '¿No está claro qué poner en "Elige una referencia"? Pregunta',
      '4': '¿No está claro qué hace la verificación de relevancia? Pregunta',
      '5': '¿No está claro cómo componer el cuadro? Pregunta',
      '7': '¿No sabes qué formato elegir? Pregunta',
      '9': '¿No funcionó a la primera? Pregunta qué se puede ajustar',
    },
    plans: '¿No sabes qué plan necesitas? Descríbelo',
    exitIntent:
      'Si no encontraste la respuesta, pregunta — es más rápido que Telegram',
  },
};

export interface AssistantStepItem {
  title: string;
  text: string;
  details: string[];
  badge?: string;
}

/**
 * Карточки шагов обучалки, структурой — не markdown-текстом (§4.4, п.4):
 * при вопросе с `stepId` сервис подставляет в промпт ИМЕННО эту карточку
 * целиком, отдельно от общей базы знаний, чтобы модель точно видела, о
 * каком шаге речь, даже если посетитель написал что-то вроде «а тут что
 * вводить» без названия шага.
 */
export function stepsFor(locale: Locale): AssistantStepItem[] {
  const dict = readJson(LANDING_DICT_DIR, locale);
  const steps = get(dict, ['steps', 'items']) as Array<{
    title: string;
    text: string;
    details?: string[];
    badge?: string;
  }>;
  return steps.map((s) => ({
    title: s.title,
    text: s.text,
    details: s.details ?? [],
    ...(s.badge ? { badge: s.badge } : {}),
  }));
}

function buildAllSteps(): Record<Locale, AssistantStepItem[]> {
  const steps: Record<Locale, AssistantStepItem[]> = {} as Record<
    Locale,
    AssistantStepItem[]
  >;
  for (const locale of LOCALES) {
    steps[locale] = stepsFor(locale);
  }
  return steps;
}

async function writeGeneratedTs(
  knowledge: Record<Locale, string>,
  steps: Record<Locale, AssistantStepItem[]>,
): Promise<void> {
  const header = `/**
 * ГЕНЕРИРУЕТСЯ автоматически — backend/scripts/build-assistant-knowledge.ts.
 * Не редактировать руками: правки уйдут при следующей сборке. Правки
 * содержания — в knowledge/manual.<locale>.md (ручной слой) или в самих
 * источниках (landing/frontend dictionaries, common/plans.ts и соседние).
 */

export const ASSISTANT_KNOWLEDGE_BUILT_AT = ${JSON.stringify(new Date().toISOString())};
export const ASSISTANT_KNOWLEDGE_COMMIT = ${JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA ?? 'local')};

export interface ProactiveTips {
  step: Record<string, string>;
  plans: string;
  exitIntent: string;
}

export interface AssistantStepItem {
  title: string;
  text: string;
  details: string[];
  badge?: string;
}

export const ASSISTANT_KNOWLEDGE: Record<string, string> = ${JSON.stringify(knowledge, null, 2)};

export const ASSISTANT_PROACTIVE_TIPS: Record<string, ProactiveTips> = ${JSON.stringify(PROACTIVE_TIPS, null, 2)};

export const ASSISTANT_SUGGESTED_QUESTIONS: Record<string, string[]> = ${JSON.stringify(SUGGESTED_QUESTIONS, null, 2)};

// Карточки шагов обучалки (§4.4, п.4) — по локали, индекс массива = stepId - 1.
export const ASSISTANT_STEPS: Record<string, AssistantStepItem[]> = ${JSON.stringify(steps, null, 2)};
`;
  // `JSON.stringify` пишет двойные кавычки — прогоняем через prettier тем
  // же конфигом, что и `npm run lint --fix` (`.prettierrc`), иначе
  // сгенерированный файл падает на первом же лендинге с сотнями
  // "Replace ... with '...'" (кавычки/запятые внутри базы знаний — не
  // разработчик забыл прогнать `--fix`, а сам генератор писал не тот стиль).
  const prettier = await import('prettier');
  const formatted = await prettier.format(header, {
    parser: 'typescript',
    singleQuote: true,
    trailingComma: 'all',
    semi: true,
    printWidth: 80,
    tabWidth: 2,
    endOfLine: 'lf',
  });
  fs.writeFileSync(path.join(OUT_DIR, 'generated.ts'), formatted, 'utf8');
}

export function buildAll(): Record<Locale, string> {
  const knowledge: Record<Locale, string> = {} as Record<Locale, string>;
  for (const locale of LOCALES) {
    knowledge[locale] = buildKnowledge(locale);
  }
  return knowledge;
}

async function main(): Promise<void> {
  const knowledge = buildAll();
  for (const locale of LOCALES) {
    fs.writeFileSync(
      path.join(OUT_DIR, `${locale}.md`),
      knowledge[locale],
      'utf8',
    );
    const kb = Buffer.byteLength(knowledge[locale], 'utf8') / 1024;
    // eslint-disable-next-line no-console
    console.log(`assistant knowledge: ${locale}.md — ${kb.toFixed(1)} KB`);
  }
  await writeGeneratedTs(knowledge, buildAllSteps());
}

// Запускается напрямую скриптом (`npm run prebuild`/`build:assistant-
// knowledge`) — но НЕ при импорте из теста (`assistant-knowledge.spec.ts`
// зовёт `buildAll()` сам, чтобы сверить с закоммиченным `generated.ts`
// без побочной записи файлов на диск при каждом прогоне jest).
if (require.main === module) {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  });
}
