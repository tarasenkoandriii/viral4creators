// Plain assertions runnable with `npx tsx scripts/greeting-help.test.ts`.
//
// Карточка → тема справки: девять карточек, пять тем (29.09.2026).

import {
  GREETING_CARD_TOPIC,
  helpTopicOf,
  type GreetingHelpTopic,
} from '../src/lib/greeting-help';

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
function eq(a: unknown, b: unknown) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${x} !== ${y}`);
}

check('девять карточек', () => {
  eq(Object.keys(GREETING_CARD_TOPIC).length, 9);
});

check('пять тем, и ни одной лишней', () => {
  const topics = [...new Set(Object.values(GREETING_CARD_TOPIC))].sort();
  eq(topics, [
    'greeting-brief',
    'greeting-references',
    'greeting-script',
    'greeting-settings',
    'greeting-video',
  ]);
});

check('пять карточек настроек ведут в одну тему', () => {
  // Голос, музыка, титры, наклейка и раскадровка — одна группа на
  // экране и одна тема в справке.
  const settings = Object.entries(GREETING_CARD_TOPIC)
    .filter(([, t]) => t === 'greeting-settings')
    .map(([hook]) => hook)
    .sort();
  eq(settings, [
    'greeting-cards-card',
    'greeting-music-card',
    'greeting-scenes-card',
    'greeting-sticker-card',
    'greeting-voice-card',
  ]);
});

check('ключ карточки — её хук, а не выдуманное имя', () => {
  // Все ключи оканчиваются на `-card` и начинаются с `greeting-`: это
  // ровно та форма, в которой их знает каталог хуков бэкенда.
  for (const hook of Object.keys(GREETING_CARD_TOPIC)) {
    if (!hook.startsWith('greeting-') || !hook.endsWith('-card')) {
      throw new Error(`ключ «${hook}» не похож на хук карточки`);
    }
  }
});

check('неизвестная карточка — null, а не чужая тема', () => {
  // Показать справку не про то, что на экране, хуже, чем не показать.
  eq(helpTopicOf('greeting-unknown-card'), null);
  eq(helpTopicOf(''), null);
});

check('известная карточка — своя тема', () => {
  const cases: Array<[string, GreetingHelpTopic]> = [
    ['greeting-brief-card', 'greeting-brief'],
    ['greeting-music-card', 'greeting-settings'],
    ['greeting-video-card', 'greeting-video'],
  ];
  for (const [hook, topic] of cases) eq(helpTopicOf(hook), topic);
});

if (failed) {
  console.error(`\n${failed} проверок упало`);
  process.exit(1);
}
console.log('\n6 проверок пройдено');
