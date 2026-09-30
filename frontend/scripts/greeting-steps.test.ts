// Plain assertions runnable with `npx tsx scripts/greeting-steps.test.ts`.
//
// Шаги поздравления — «Тонкая красная линия» §4.5, волна D, этап 12.

import {
  GREETING_STEP_IDS,
  greetingFactsOf,
  greetingStepOf,
  greetingSteps,
  type GreetingFacts,
  type GreetingStepId,
} from '../src/lib/greeting-steps';
import { toStepsView } from '../src/lib/wizard-steps';
import { readFileSync } from 'node:fs';

const LABELS: Record<GreetingStepId, string> = {
  brief: 'Повод',
  references: 'Фото',
  script: 'Сценарий',
  video: 'Видео',
};

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}
function eq(actual: unknown, expected: unknown, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n    ожидалось ${b}\n    получено ${a}`);
}

const facts = (over: Partial<GreetingFacts> = {}): GreetingFacts => ({
  hasSession: true,
  hasPrompt: false,
  hasVideo: false,
  ...over,
});

check('идентификаторы шагов не разъезжаются со списком', () => {
  eq(
    greetingSteps(facts(), LABELS).map((s) => s.id),
    [...GREETING_STEP_IDS]
  );
});

check('до сессии доступен только бриф', () => {
  const view = toStepsView(
    greetingSteps(facts({ hasSession: false }), LABELS),
    'brief'
  );
  eq(view.selectable, [true, false, false, false]);
  eq(view.current, 0);
});

check('после сессии открыты фото и сценарий, видео — нет', () => {
  const view = toStepsView(greetingSteps(facts(), LABELS), 'references');
  eq(view.selectable, [true, true, true, false]);
});

check('видео открывается вместе со сценарием', () => {
  const view = toStepsView(
    greetingSteps(facts({ hasPrompt: true }), LABELS),
    'script'
  );
  eq(view.selectable, [true, true, true, true]);
});

check('бриф остаётся доступен после сборки сценария', () => {
  // Помеченный модерацией сценарий чинится правкой текста на брифе —
  // закрыть туда дорогу значило бы закрыть единственный выход.
  const view = toStepsView(
    greetingSteps(facts({ hasPrompt: true, hasVideo: true }), LABELS),
    'video'
  );
  eq(view.targets[0], 'brief');
});

check('завершённость задаётся фактами, а не позицией', () => {
  // Позиционное правило объявило бы фото пройденными просто потому,
  // что человек дошёл до сценария.
  const view = toStepsView(greetingSteps(facts(), LABELS), 'references');
  eq(view.done, [true, false, false, false]);
});

check('текущий шаг читается из состояния', () => {
  eq(greetingStepOf(facts({ hasSession: false })), 'brief');
  eq(greetingStepOf(facts()), 'references');
  eq(greetingStepOf(facts({ hasPrompt: true })), 'script');
  eq(greetingStepOf(facts({ hasPrompt: true, hasVideo: true })), 'video');
});

check('готовый ролик не считается началом', () => {
  // Ровно тот блокер, из-за которого степпер врал после перезагрузки:
  // сессия есть, промпт и видео дочитаны — шаг обязан быть последним.
  const restored = greetingFactsOf('s1', { id: 'p' }, { id: 'v' });
  eq(greetingStepOf(restored), 'video');
});

check('потерянный при загрузке промпт даёт первый шаг — это и был баг', () => {
  const broken = greetingFactsOf('s1', undefined, undefined);
  eq(greetingStepOf(broken), 'references');
});

/**
 * ЖИВЫЕ позиции степпера в каждом из трёх состояний мастера
 * (29.09.2026, этап обучалок по поздравлению).
 *
 * Каталог хуков обучалки
 * (`backend/src/modules/tutorial-scenario/qa-hooks.ts`) объявляет у
 * каждой позиции степпера маршрут — экран, на котором по ней МОЖНО
 * КЛИКНУТЬ. Нарисованы все четыре везде, живой делает
 * `clickable = !active && selectable[i]`, и перепутать «видно» с
 * «кликается» уже стоило мастеру товара восьми сценариев из девяти:
 * сценарий ждал выключенную кнопку тридцать секунд и падал.
 *
 * Здесь это правило зафиксировано с той стороны, где оно и живёт.
 * Каталог обязан совпадать с этой таблицей:
 *
 *   greeting-video           — живых нет вовсе;
 *   greeting-video-drafting  — «Бриф» и «Сценарий»;
 *   greeting-video-ready     — «Бриф», «Фото» и «Ролик».
 */
const liveSteps = (f: GreetingFacts): GreetingStepId[] => {
  const view = toStepsView(greetingSteps(f, LABELS), greetingStepOf(f));
  return GREETING_STEP_IDS.filter(
    (_, i) => i !== view.current && view.selectable[i]
  ) as GreetingStepId[];
};

/**
 * Таблица, которую читает шов `check-docs.mjs`: имя маршрута обучалки →
 * позиции степпера, живые на нём. Литералом и в разбираемой форме
 * именно затем, чтобы каталог хуков на бэкенде не разошёлся с этим
 * файлом молча.
 */
const LIVE_BY_ROUTE: Record<string, GreetingStepId[]> = {
  'greeting-video': [],
  'greeting-video-drafting': ['brief', 'script'],
  'greeting-video-ready': ['brief', 'references', 'video'],
};

check('на свежем проекте ни одна позиция степпера не кликается', () => {
  eq(liveSteps(facts({ hasSession: false })), LIVE_BY_ROUTE['greeting-video']);
});

check('сессия без сценария: живы «Бриф» и «Сценарий»', () => {
  eq(liveSteps(facts()), LIVE_BY_ROUTE['greeting-video-drafting']);
});

check('сценарий собран: живы «Бриф», «Фото» и «Ролик»', () => {
  eq(
    liveSteps(facts({ hasPrompt: true })),
    LIVE_BY_ROUTE['greeting-video-ready']
  );
});

// ── Маски личного текста для кадров лендинга ─────────────────────────
//
// Этап I ТЗ `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` (§5.3).
// Настоящие кадры мастера снимаются немаскированным прогоном (иначе не
// видно постера ролика), а поля с именами и свободным текстом должны быть
// размыты и там: выдуманное имя на маркетинговом кадре запрещено. Бэкенд
// размывает всё, что помечено `data-qa-mask="personal-…"`
// (`PERSONAL_TEXT_MASK_CSS`), — а помечено ли поле, держит только этот
// файл: забытая маска не роняет ни сборку, ни съёмку, она роняет кадр,
// и заметить это можно лишь глазами на лендинге.
//
// Здесь, а не отдельным файлом: число unit-скриптов фронтенда сверяется
// с документами (check-docs), а проверка — продолжение той же темы
// «экраны мастера, которые снимает прогон».

const src = (rel: string) =>
  readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');

/** Поле с хуком `data-qa` и маской СРАЗУ следующей строкой — так маска
 *  не уедет к соседнему элементу незаметно. */
const MASKED_FIELDS: Array<[file: string, qa: string, mask: string]> = [
  [
    'features/projects/greeting/BriefStep.tsx',
    'data-qa={BRIEF_VOICE_TARGETS.recipient}',
    'personal-recipient',
  ],
  [
    'features/projects/greeting/BriefStep.tsx',
    'data-qa={BRIEF_VOICE_TARGETS.sender}',
    'personal-sender',
  ],
  [
    'features/projects/greeting/BriefStep.tsx',
    'data-qa={BRIEF_VOICE_TARGETS.message}',
    'personal-message',
  ],
  [
    'features/projects/GreetingOccasionFields.tsx',
    'data-qa="greeting-field-custom-occasion"',
    'personal-custom-occasion',
  ],
  [
    'features/projects/greeting/ScriptStep.tsx',
    'data-qa="greeting-script-edit"',
    'personal-script',
  ],
  [
    'features/projects/greeting/CardsStep.tsx',
    'data-qa="greeting-cards-title"',
    'personal-card-title',
  ],
  [
    'features/projects/greeting/CardsStep.tsx',
    'data-qa="greeting-cards-closing"',
    'personal-card-closing',
  ],
  [
    'features/projects/greeting/ReferencesStep.tsx',
    'data-qa="greeting-references-label"',
    'personal-reference-label',
  ],
  [
    'features/projects/greeting/ReferencesStep.tsx',
    'data-qa="greeting-references-description"',
    'personal-reference-description',
  ],
];

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

check('каждое поле с именем или свободным текстом помечено маской', () => {
  for (const [file, qa, mask] of MASKED_FIELDS) {
    const text = src(file);
    const all = text.split(qa).length - 1;
    if (all === 0) throw new Error(`${file}: хук ${qa} не найден`);
    const masked = (
      text.match(
        new RegExp(`${escapeRe(qa)}\\s*\\n\\s*data-qa-mask="${mask}"`, 'g')
      ) ?? []
    ).length;
    // Каждое вхождение: у ссылок и описаний референсов по две формы
    // (добавление и правка), и маска на одной из них — дыра на кадре.
    eq(masked, all, `${file}: ${qa} без маски ${mask}`);
  }
});

/** Личный текст без поля-хука: сводки, подписи, подсказки. */
const MASKED_TEXT: Array<[file: string, mask: string, count: number]> = [
  // Подпись и описание в списке — вдобавок к двум формам выше.
  [
    'features/projects/greeting/ReferencesStep.tsx',
    'personal-reference-label',
    3,
  ],
  [
    'features/projects/greeting/ReferencesStep.tsx',
    'personal-reference-description',
    3,
  ],
  // Кнопки «взять подсказку»: подсказка титра собрана с именем.
  ['features/projects/greeting/CardsStep.tsx', 'personal-card-suggestion', 2],
  [
    'features/projects/greeting/CharacterBlock.tsx',
    'personal-character-summary',
    1,
  ],
  ['features/projects/greeting/SenderVoiceStep.tsx', 'personal-voice-label', 1],
  ['features/voice/VoiceConsentCard.tsx', 'personal-recipient', 1],
  ['features/voice/VoiceConsentCard.tsx', 'personal-occasion', 1],
  // Своя музыка: название трека (строка выбора и поле загрузки).
  ['features/projects/greeting/MusicThemeStep.tsx', 'personal-music-title', 2],
  // Голосовой помощник: продиктованные значения и распознанная фраза.
  ['features/voice/VoiceConfirmCard.tsx', 'personal-voice-value', 1],
  ['features/voice/VoiceAssistant.tsx', 'personal-voice-transcript', 1],
];

check('сводки и подписи с личным текстом тоже под маской', () => {
  for (const [file, mask, count] of MASKED_TEXT) {
    const n =
      src(file).split(`'${mask}'`).length -
      1 +
      src(file).split(`"${mask}"`).length -
      1;
    eq(n, count, `${file}: маска ${mask}`);
  }
});

check('префикс маски — тот же, что размывает бэкенд', () => {
  const backend = readFileSync(
    new URL(
      '../../backend/src/modules/ui-snapshot/ui-snapshot-runner.service.ts',
      import.meta.url
    ),
    'utf8'
  );
  const prefix = /PERSONAL_TEXT_MASK_PREFIX = '([a-z-]+)'/.exec(backend)?.[1];
  eq(prefix, 'personal-', 'PERSONAL_TEXT_MASK_PREFIX в ui-snapshot-runner');
  for (const [, , mask] of MASKED_FIELDS) {
    if (!mask.startsWith(prefix ?? '?'))
      throw new Error(`маска ${mask} не под префиксом ${prefix}`);
  }
  for (const [, mask] of MASKED_TEXT) {
    if (!mask.startsWith(prefix ?? '?'))
      throw new Error(`маска ${mask} не под префиксом ${prefix}`);
  }
});

if (failed) {
  console.error(`\n${failed} проверок упало`);
  process.exit(1);
}
console.log('\n15 проверок пройдено');
