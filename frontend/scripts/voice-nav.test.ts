// Plain assertions runnable with `npx tsx scripts/voice-nav.test.ts`.
//
// Этап K6 ТЗ Greeting 2.0 §4А.7.2, §4А.7.3: голосовая навигация по шагам
// (тот же список, что у степпера) и голосовая справка (тот же резолвер,
// что у кнопки (i)); «карточка в фокусе».

import { getDictionary } from '../src/lib/get-dictionary';
import { GREETING_CARD_TOPIC, helpTopicOf } from '../src/lib/greeting-help';
import {
  greetingStepOf,
  greetingSteps,
  type GreetingFacts,
  type GreetingStepId,
} from '../src/lib/greeting-steps';
import { locales } from '../src/lib/i18n';
import {
  K3_INTENT_HANDLERS,
  dispatchVoiceResult,
  type VoiceDispatchContext,
} from '../src/lib/voice-intents';
import {
  decideNavigation,
  greetingStepLabels,
  helpHandler,
  navRefusalText,
  navTextsFor,
  navigateHandler,
  replyLocale,
  stepIsReachable,
  voiceHelpTopic,
  withNavHelpHandlers,
  type NavDecision,
  type VoiceNavHandlersContext,
  type VoiceNavState,
  type VoiceNavTarget,
} from '../src/lib/voice-nav';
import {
  isMostlyVisible,
  pickFocusCard,
  visiblePx,
} from '../src/lib/voice-nav-focus';
import type {
  VoiceIntent,
  VoiceUnderstandResult,
} from '../src/lib/voice-types';
import { toStepsView, type WizardStep } from '../src/lib/wizard-steps';

let failed = 0;
let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}
function eq(a: unknown, b: unknown) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${x} !== ${y}`);
}

const ru = getDictionary('ru');
const LABELS = greetingStepLabels(ru.greetingVideoWizard);

/** Состояние степпера ровно так, как его строит мастер. */
function navOf(facts: GreetingFacts): VoiceNavState {
  const steps = greetingSteps(facts, LABELS);
  return { steps, view: toStepsView(steps, greetingStepOf(facts)), facts };
}
const BRIEF: GreetingFacts = {
  hasSession: false,
  hasPrompt: false,
  hasVideo: false,
};
const REFS: GreetingFacts = {
  hasSession: true,
  hasPrompt: false,
  hasVideo: false,
};
const SCRIPT: GreetingFacts = {
  hasSession: true,
  hasPrompt: true,
  hasVideo: false,
};
const VIDEO: GreetingFacts = {
  hasSession: true,
  hasPrompt: true,
  hasVideo: true,
};
const ALL_FACTS = [BRIEF, REFS, SCRIPT, VIDEO];

const go = (step: GreetingStepId): NavDecision => ({ kind: 'go', step });
const no = (
  reason: Extract<NavDecision, { kind: 'refuse' }>['reason'],
  step: GreetingStepId | null
): Extract<NavDecision, { kind: 'refuse' }> => ({
  kind: 'refuse',
  reason,
  step,
});

function result(
  intent: VoiceIntent,
  language: string | null = 'ru'
): VoiceUnderstandResult {
  return {
    status: 'ok',
    transcript: 'x',
    language,
    intent,
    confidence: 1,
    reply: null,
    scriptMismatch: false,
  };
}
const dispatchCtx: VoiceDispatchContext = {
  hasPending: false,
  canFill: (t) => t === 'greeting-field-recipient',
  command: () => null,
  texts: { unknown: 'UNKNOWN', manual: 'MANUAL', nothingPending: 'NOTHING' },
};
function handlersCtx(
  over: Partial<VoiceNavHandlersContext> = {}
): VoiceNavHandlersContext {
  return {
    nav: navOf(REFS),
    card: null,
    stepCard: 'greeting-references-card',
    canOpenHelp: true,
    uiLocale: 'ru',
    // По умолчанию секция шага на экране — прежнее «вы уже там».
    stepInView: () => true,
    ...over,
  };
}

// ── Подписи и доступность — одни со степпером ──────────────────────────

check('подписи шагов — те же ключи словаря, что у степпера', () => {
  const w = ru.greetingVideoWizard;
  eq(LABELS, {
    brief: w.occasionLabel,
    references: w.referencesHeading,
    script: w.scriptHeading,
    video: w.videoHeading,
  });
});

check(
  'доступность шага = кликабельность кнопки Stepper во всех состояниях',
  () => {
    // `Stepper`: clickable = !active && selectable[i] (при заданном onSelect).
    for (const f of ALL_FACTS) {
      const { view } = navOf(f);
      view.steps.forEach((_, i) => {
        const stepper = i !== view.current && view.selectable[i] === true;
        eq([i, stepIsReachable(view, i)], [i, stepper]);
      });
    }
  }
);

// ── Решение навигации ─────────────────────────────────────────────────

const TABLE: Array<[GreetingFacts, Record<VoiceNavTarget, NavDecision>]> = [
  [
    BRIEF,
    {
      next: no('no-session', 'references'),
      back: no('first', null),
      brief: no('here', 'brief'),
      references: no('no-session', 'references'),
      script: no('no-session', 'script'),
      video: no('no-session', 'video'),
    },
  ],
  [
    REFS,
    {
      next: go('script'),
      back: go('brief'),
      brief: go('brief'),
      references: no('here', 'references'),
      script: go('script'),
      video: no('no-script', 'video'),
    },
  ],
  [
    SCRIPT,
    {
      next: go('video'),
      back: go('references'),
      brief: go('brief'),
      references: go('references'),
      script: no('here', 'script'),
      video: go('video'),
    },
  ],
  [
    VIDEO,
    {
      next: no('last', null),
      back: go('script'),
      brief: go('brief'),
      references: go('references'),
      script: go('script'),
      video: no('here', 'video'),
    },
  ],
];

check('таблица переходов по четырём состояниям мастера', () => {
  for (const [facts, row] of TABLE) {
    for (const to of Object.keys(row) as VoiceNavTarget[]) {
      eq(
        [greetingStepOf(facts), to, decideNavigation(to, navOf(facts))],
        [greetingStepOf(facts), to, row[to]]
      );
    }
  }
});

check('переход — ровно цель степпера (та же прокрутка, что у клика)', () => {
  for (const f of ALL_FACTS) {
    const nav = navOf(f);
    for (const to of [
      'next',
      'back',
      'brief',
      'references',
      'script',
      'video',
    ] as const) {
      const d = decideNavigation(to, nav);
      if (d.kind !== 'go') continue;
      const i = nav.view.targets.indexOf(d.step);
      if (i < 0 || !stepIsReachable(nav.view, i)) {
        throw new Error(`${to}: ${d.step} не кликабелен в степпере`);
      }
    }
  }
});

check('решает список шагов, а не второй список: чужая цель — отказ', () => {
  // Тот же набор фактов, но шаг сценария закрыт в самом списке: голос
  // обязан подчиниться списку, а не «знать», что сценарий доступен.
  const facts = REFS;
  const steps: WizardStep<GreetingStepId>[] = greetingSteps(facts, LABELS).map(
    (s) => (s.id === 'script' ? { ...s, target: null } : s)
  );
  const nav = { steps, view: toStepsView(steps, 'references'), facts };
  eq(decideNavigation('script', nav).kind, 'refuse');
  eq(decideNavigation('next', nav).kind, 'refuse');
  // И наоборот — порядок тоже из списка: без шага фото «назад» со
  // сценария ведёт на бриф.
  const short = greetingSteps(SCRIPT, LABELS).filter(
    (s) => s.id !== 'references'
  );
  eq(
    decideNavigation('back', {
      steps: short,
      view: toStepsView(short, 'script'),
      facts: SCRIPT,
    }),
    go('brief')
  );
});

check('неизвестная цель (клиент не верит серверу) — отказ, не падение', () => {
  eq(
    decideNavigation('admin' as VoiceNavTarget, navOf(SCRIPT)),
    no('unavailable', null)
  );
});

// ── Тексты отказа ─────────────────────────────────────────────────────

check('отказ — причиной и с названием шага', () => {
  const { texts, labels } = navTextsFor('ru', 'ru');
  eq(
    navRefusalText(no('no-script', 'video'), texts, labels),
    `Шаг «${LABELS.video}» пока недоступен: сценарий ещё не собран.`
  );
  eq(navRefusalText(no('first', null), texts, labels), texts.first);
});

check('в пяти словарях шаблоны с {step} и без — как ожидает код', () => {
  for (const l of locales) {
    const t = getDictionary(l).voiceNav;
    for (const k of [
      'here',
      'hereShowing',
      'noSession',
      'noScript',
      'unavailable',
    ] as const) {
      if (!t[k].includes('{step}')) throw new Error(`${l}.${k} без {step}`);
    }
    for (const k of ['first', 'last', 'noHelp'] as const) {
      if (t[k].includes('{')) throw new Error(`${l}.${k} с подстановкой`);
      if (!t[k].trim()) throw new Error(`${l}.${k} пуст`);
    }
  }
});

check('язык реплики — язык речи из пяти, иначе интерфейса', () => {
  eq(replyLocale('uk', 'ru'), 'uk');
  eq(replyLocale('fr', 'de'), 'de');
  eq(replyLocale(null, 'es'), 'es');
  const { texts, labels } = navTextsFor('en', 'ru');
  eq(texts.first, getDictionary('en').voiceNav.first);
  eq(labels.script, getDictionary('en').greetingVideoWizard.scriptHeading);
});

// ── Обработчики в реестре ─────────────────────────────────────────────

check(
  'navigate: доступный шаг — план navigate, без карточки подтверждения',
  () => {
    const reg = withNavHelpHandlers(K3_INTENT_HANDLERS, handlersCtx());
    eq(
      dispatchVoiceResult(
        result({ kind: 'navigate', to: 'next' }),
        reg,
        dispatchCtx
      ),
      { kind: 'navigate', step: 'script' }
    );
  }
);

check('navigate: отказ на языке речи', () => {
  const reg = withNavHelpHandlers(
    K3_INTENT_HANDLERS,
    handlersCtx({ nav: navOf(BRIEF), uiLocale: 'ru' })
  );
  const plan = dispatchVoiceResult(
    result({ kind: 'navigate', to: 'video' }, 'de'),
    reg,
    dispatchCtx
  );
  const de = getDictionary('de');
  eq(plan, {
    kind: 'reply',
    text: de.voiceNav.noSession.replace(
      '{step}',
      de.greetingVideoWizard.videoHeading
    ),
  });
});

check('свой шаг на экране — «вы уже на шаге», без прокрутки', () => {
  const reg = withNavHelpHandlers(
    K3_INTENT_HANDLERS,
    handlersCtx({ nav: navOf(SCRIPT), stepInView: () => true })
  );
  eq(
    dispatchVoiceResult(
      result({ kind: 'navigate', to: 'script' }),
      reg,
      dispatchCtx
    ),
    { kind: 'reply', text: `Вы уже на шаге «${LABELS.script}».` }
  );
});

check('свой шаг, но человек укатил — прокрутка к нему с репликой', () => {
  const asked: GreetingStepId[] = [];
  const reg = withNavHelpHandlers(
    K3_INTENT_HANDLERS,
    handlersCtx({
      nav: navOf(SCRIPT),
      stepInView: (s) => {
        asked.push(s);
        return false;
      },
    })
  );
  eq(
    dispatchVoiceResult(
      result({ kind: 'navigate', to: 'script' }, 'uk'),
      reg,
      dispatchCtx
    ),
    {
      kind: 'navigate',
      step: 'script',
      text: getDictionary('uk').voiceNav.hereShowing.replace(
        '{step}',
        getDictionary('uk').greetingVideoWizard.scriptHeading
      ),
    }
  );
  eq(asked, ['script']);
});

check('вне экрана не открывает шагов, закрытых степпером', () => {
  // Секции не видно — но это не повод вести туда, куда степпер не пускает.
  const reg = withNavHelpHandlers(
    K3_INTENT_HANDLERS,
    handlersCtx({ nav: navOf(REFS), stepInView: () => false })
  );
  eq(
    dispatchVoiceResult(
      result({ kind: 'navigate', to: 'video' }),
      reg,
      dispatchCtx
    ).kind,
    'reply'
  );
  eq(
    dispatchVoiceResult(
      result({ kind: 'navigate', to: 'back' }),
      reg,
      dispatchCtx
    ),
    { kind: 'navigate', step: 'brief' }
  );
});

check('navigate без степпера — «сделайте руками», а не молчание', () => {
  const h = navigateHandler(handlersCtx({ nav: null }));
  eq(
    h(
      { kind: 'navigate', to: 'next' },
      dispatchCtx,
      result({ kind: 'unknown' })
    ),
    {
      kind: 'reply',
      text: 'MANUAL',
    }
  );
});

check('K3-обработчики на месте после добавления K6', () => {
  const reg = withNavHelpHandlers(K3_INTENT_HANDLERS, handlersCtx());
  const fill: VoiceIntent = {
    kind: 'fill',
    fields: [
      { target: 'greeting-field-recipient', value: 'Анна', label: 'Кому' },
    ],
  };
  eq(dispatchVoiceResult(result(fill), reg, dispatchCtx).kind, 'propose');
  eq(dispatchVoiceResult(result({ kind: 'confirm' }), reg, dispatchCtx), {
    kind: 'reply',
    text: 'NOTHING',
  });
});

check('help: тема карточки в фокусе — тем же резолвером, что у (i)', () => {
  for (const hook of Object.keys(GREETING_CARD_TOPIC)) {
    eq(voiceHelpTopic(hook, 'greeting-brief-card'), helpTopicOf(hook));
  }
  const reg = withNavHelpHandlers(
    K3_INTENT_HANDLERS,
    handlersCtx({ card: 'greeting-music-card' })
  );
  eq(dispatchVoiceResult(result({ kind: 'help' }), reg, dispatchCtx), {
    kind: 'help',
    topic: 'greeting-settings',
  });
});

check('help: карточка без темы или без фокуса — тема карточки шага', () => {
  eq(
    voiceHelpTopic('greeting-unknown-card', 'greeting-script-card'),
    'greeting-script'
  );
  eq(voiceHelpTopic(null, 'greeting-video-card'), 'greeting-video');
});

check('help: нет листа справки — честный ответ на языке речи', () => {
  const h = helpHandler(handlersCtx({ canOpenHelp: false }));
  eq(h({ kind: 'help' }, dispatchCtx, result({ kind: 'help' }, 'es')), {
    kind: 'reply',
    text: getDictionary('es').voiceNav.noHelp,
  });
  const none = helpHandler(
    handlersCtx({ card: 'x-card', stepCard: 'also-unknown-card' })
  );
  eq(none({ kind: 'help' }, dispatchCtx, result({ kind: 'help' }, null)), {
    kind: 'reply',
    text: ru.voiceNav.noHelp,
  });
});

// ── Карточка в фокусе ─────────────────────────────────────────────────

const VH = 800;
const box = (hook: string, top: number, bottom: number) => ({
  hook,
  top,
  bottom,
});

check('секция «на экране» — то же правило четверти', () => {
  eq(isMostlyVisible(box('s', 0, 400), VH), true);
  eq(isMostlyVisible(box('s', -350, 50), VH), false);
  eq(isMostlyVisible(box('s', -2000, 300), VH), true);
  eq(isMostlyVisible(box('s', 900, 1300), VH), false);
});

check('видимая часть карточки', () => {
  eq(visiblePx(box('a', -100, 300), VH), 300);
  eq(visiblePx(box('a', 700, 1200), VH), 100);
  eq(visiblePx(box('a', 900, 1200), VH), 0);
  eq(visiblePx(box('a', -500, 2000), VH), VH);
});

check('последняя тронутая карточка, пока она на экране', () => {
  const cards = [box('brief', -200, 300), box('music', 300, 1400)];
  eq(
    pickFocusCard({ interacted: 'brief', cards, viewport: VH, fallback: 'fb' }),
    'brief'
  );
});

check('тронутая карточка уехала — самая видимая', () => {
  const cards = [
    box('brief', -900, -100),
    box('script', -100, 200),
    box('music', 200, 1400),
  ];
  eq(
    pickFocusCard({ interacted: 'brief', cards, viewport: VH, fallback: 'fb' }),
    'music'
  );
});

check('от тронутой видна лишь полоска (<25%) — самая видимая', () => {
  // 90 из 400 пикселей — уголок у края экрана, не то, на что смотрят.
  const cards = [box('brief', -310, 90), box('music', 90, 900)];
  eq(
    pickFocusCard({ interacted: 'brief', cards, viewport: VH, fallback: 'fb' }),
    'music'
  );
  // 100 из 400 — ровно четверть: ещё на экране.
  const edge = [box('brief', -300, 100), box('music', 100, 900)];
  eq(
    pickFocusCard({
      interacted: 'brief',
      cards: edge,
      viewport: VH,
      fallback: 'fb',
    }),
    'brief'
  );
});

check('карточка выше окна и тронута — остаётся в фокусе', () => {
  const cards = [box('brief', -1000, 1200)];
  eq(
    pickFocusCard({ interacted: 'brief', cards, viewport: VH, fallback: 'fb' }),
    'brief'
  );
  // Карточка в 3000px видна на 300: четверть считается от ОКНА (200), а
  // не от карточки (750) — иначе длинный бриф терял бы фокус, едва
  // его начали листать.
  const tall = [box('brief', -2700, 300), box('music', 300, 1300)];
  eq(
    pickFocusCard({
      interacted: 'brief',
      cards: tall,
      viewport: VH,
      fallback: 'fb',
    }),
    'brief'
  );
});

check('ни касаний, ни видимых карточек — карточка шага', () => {
  eq(
    pickFocusCard({
      interacted: null,
      cards: [],
      viewport: VH,
      fallback: 'fb',
    }),
    'fb'
  );
  eq(
    pickFocusCard({
      interacted: 'gone',
      cards: [box('a', 900, 1000)],
      viewport: VH,
      fallback: 'fb',
    }),
    'fb'
  );
});

check('равная видимость — та, что выше в ленте', () => {
  const cards = [box('a', 0, 400), box('b', 400, 800)];
  eq(
    pickFocusCard({ interacted: null, cards, viewport: VH, fallback: 'fb' }),
    'a'
  );
});

if (failed) {
  console.error(`\n${failed} проверок упало`);
  process.exit(1);
}
console.log(`\n${passed} проверок пройдено`);
