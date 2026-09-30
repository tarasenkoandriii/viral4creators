// Plain assertions runnable with `npx tsx scripts/voice-proactive.test.ts`.
//
// Проактивный голос помощника — этап K4 ТЗ Greeting 2.0 §4А.2 п.1, п.5.
// Проверяется то, что стоит доверия и денег: в запрос уходят только коды
// (не текст), повод не повторяется, без звука — только строка, ответ на
// вопрос без факта ведёт к справке, простой повторяет реплику один раз.

import {
  REFUSAL_REPEAT_MS,
  SPEECH_STALE_MS,
  createSpeechQueue,
  proactiveDecision,
  VOICE_IDLE_REPEAT_MS,
  becameReady,
  createProactiveMemory,
  idleRepeatDue,
  proactiveChannel,
  questionHandler,
  questionTopicOf,
  refusalOf,
  refusalOfStartError,
  speakBodyOf,
} from '../src/lib/voice-proactive';
import { HINT_IDLE_MS } from '../src/lib/hint-line';
import { createHintPlayer, type AudioLike } from '../src/lib/hint-audio';
import {
  dispatchVoiceResult,
  K3_INTENT_HANDLERS,
  type VoiceDispatchContext,
} from '../src/lib/voice-intents';
import { withQuestionHandler } from '../src/lib/voice-proactive';
import { planLine } from '../src/lib/voice-route';
import type { VoiceUnderstandResult } from '../src/lib/voice-types';

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
function eq(actual: unknown, expected: unknown, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n    ожидалось ${b}\n    получено ${a}`);
}

check('простой голоса — 20 с по ТЗ, строка текста — прежние 8 с', () => {
  eq(VOICE_IDLE_REPEAT_MS, 20_000);
  eq(HINT_IDLE_MS, 8000);
});

check('в запрос речи уходят только вид и коды — ни одного текста', () => {
  eq(speakBodyOf({ kind: 'refusal', refusal: 'tone' }, 'ru'), {
    kind: 'refusal',
    refusal: 'tone',
    locale: 'ru',
  });
  eq(speakBodyOf({ kind: 'video-ready', sessionId: 's1' }, 'de'), {
    kind: 'video-ready',
    locale: 'de',
  });
  // Отпечаток сводки — память клиента, серверу он не нужен.
  eq(speakBodyOf({ kind: 'consent-summary', fingerprint: 'fp' }, 'en'), {
    kind: 'consent-summary',
    locale: 'en',
  });
});

check('ответ на вопрос — на языке реплики, иначе интерфейса', () => {
  eq(speakBodyOf({ kind: 'answer', topic: 'how-long', language: 'uk' }, 'ru'), {
    kind: 'answer',
    topic: 'how-long',
    locale: 'uk',
  });
  eq(
    speakBodyOf({ kind: 'answer', topic: 'how-long', language: 'fr' }, 'ru')
      .locale,
    'ru'
  );
  eq(
    speakBodyOf({ kind: 'answer', topic: 'how-long', language: null }, 'es')
      .locale,
    'es'
  );
});

check('память: готовый ролик — раз на сессию', () => {
  const m = createProactiveMemory();
  eq(m.admit({ kind: 'video-ready', sessionId: 's1' }, 0), true);
  eq(m.admit({ kind: 'video-ready', sessionId: 's1' }, 99_999), false);
  eq(m.admit({ kind: 'video-ready', sessionId: 's2' }, 0), true);
});

check('память: сводка — раз на отпечаток', () => {
  const m = createProactiveMemory();
  eq(m.admit({ kind: 'consent-summary', fingerprint: 'a' }, 0), true);
  eq(m.admit({ kind: 'consent-summary', fingerprint: 'a' }, 1), false);
  // Условия поменялись — новая сводка звучит.
  eq(m.admit({ kind: 'consent-summary', fingerprint: 'b' }, 2), true);
});

check('память: тот же отказ — не чаще раза в 30 с, другой — сразу', () => {
  const m = createProactiveMemory();
  eq(m.admit({ kind: 'refusal', refusal: 'quota' }, 0), true);
  eq(
    m.admit({ kind: 'refusal', refusal: 'quota' }, REFUSAL_REPEAT_MS - 1),
    false
  );
  eq(m.admit({ kind: 'refusal', refusal: 'tone' }, 1), true);
  eq(m.admit({ kind: 'refusal', refusal: 'quota' }, REFUSAL_REPEAT_MS), true);
});

check('память: ответ на вопрос — всегда (человек спросил сам)', () => {
  const m = createProactiveMemory();
  const e = { kind: 'answer', topic: 'what-next', language: 'ru' } as const;
  eq(m.admit(e, 0), true);
  eq(m.admit(e, 1), true);
});

check(
  'канал: голос только со звуком, после касания и в пределах потолка',
  () => {
    const on = {
      voice: true,
      muted: false,
      gestured: true,
      budgetExhausted: false,
    };
    eq(proactiveChannel(on), 'voice');
    eq(proactiveChannel({ ...on, muted: true }), 'text');
    eq(proactiveChannel({ ...on, gestured: false }), 'text');
    eq(proactiveChannel({ ...on, budgetExhausted: true }), 'text');
    eq(proactiveChannel({ ...on, voice: false }), 'text');
  }
);

check('ролик готов — только перемена на глазах', () => {
  eq(becameReady('processing', 'complete'), true);
  eq(becameReady(null, 'complete'), true);
  // Страница открылась с готовым роликом — не повод.
  eq(becameReady(undefined, 'complete'), false);
  eq(becameReady('complete', 'complete'), false);
  eq(becameReady('processing', 'failed'), false);
});

check('отказ старта → код: стена, лимит; прочее — не наш повод', () => {
  eq(refusalOfStartError(403, true), 'locked');
  eq(refusalOfStartError(403, false), 'quota');
  eq(refusalOfStartError(429, false), 'quota');
  eq(refusalOfStartError(500, false), null);
  eq(refusalOfStartError(null, false), null);
});

check('коды из ответа — только закрытые списки', () => {
  eq(refusalOf('tone'), 'tone');
  eq(refusalOf('anything'), null);
  eq(refusalOf(undefined), null);
  eq(questionTopicOf('why-photo'), 'why-photo');
  eq(questionTopicOf('price'), null);
});

check('повтор после простоя — один раз и только со звуком', () => {
  const base = {
    voice: true,
    muted: false,
    spokenKey: 'k1',
    repeatedKey: null,
  };
  eq(idleRepeatDue(base), true);
  eq(idleRepeatDue({ ...base, repeatedKey: 'k1' }), false);
  eq(idleRepeatDue({ ...base, repeatedKey: 'k0' }), true);
  eq(idleRepeatDue({ ...base, muted: true }), false);
  eq(idleRepeatDue({ ...base, voice: false }), false);
  eq(idleRepeatDue({ ...base, spokenKey: null }), false);
});

// ── Вопрос о шаге через реестр интентов ──────────────────────────────

const ctx: Omit<VoiceDispatchContext, 'hasPending'> & { hasPending: boolean } =
  {
    hasPending: false,
    canFill: () => false,
    command: () => null,
    texts: { unknown: 'не понял', manual: 'руками', nothingPending: 'нечего' },
  };

const result = (
  intent: VoiceUnderstandResult['intent'],
  reply: string | null
): VoiceUnderstandResult => ({
  status: 'ok',
  transcript: 'x',
  language: 'ru',
  intent,
  confidence: 0.9,
  reply,
  scriptMismatch: false,
});

check('без обработчика вопрос не теряется молча — «руками»', () => {
  const plan = dispatchVoiceResult(
    result({ kind: 'question', topic: 'how-long', answered: true }, 'ответ'),
    K3_INTENT_HANDLERS,
    ctx
  );
  eq(plan.kind, 'reply');
});

check('ответ из фактов — строкой, без кнопки справки', () => {
  const registry = withQuestionHandler(K3_INTENT_HANDLERS, {
    card: 'greeting-video-card',
    stepCard: 'greeting-video-card',
    canOpenHelp: true,
  });
  const r = result(
    { kind: 'question', topic: 'how-long', answered: true },
    'Ролик обычно генерируется несколько минут.'
  );
  const plan = dispatchVoiceResult(r, registry, ctx);
  eq(plan, {
    kind: 'answer',
    text: 'Ролик обычно генерируется несколько минут.',
    topic: 'how-long',
    answered: true,
    help: null,
  });
  eq(planLine(plan, r), {
    text: 'Ролик обычно генерируется несколько минут.',
    tone: 'info',
  });
});

check('факта нет — «не знаю» и кнопка справки темы карточки в фокусе', () => {
  const handler = questionHandler({
    card: 'greeting-references-card',
    stepCard: 'greeting-brief-card',
    canOpenHelp: true,
  });
  const r = result(
    { kind: 'question', topic: null, answered: false },
    'Этого я не знаю. Посмотрите справку.'
  );
  const plan = handler(
    { kind: 'question', topic: null, answered: false },
    ctx,
    r
  );
  eq(plan.kind, 'answer');
  if (plan.kind !== 'answer') return;
  eq(plan.answered, false);
  eq(plan.topic, null);
  eq(plan.text, 'Этого я не знаю. Посмотрите справку.');
  if (!plan.help) throw new Error('кнопки справки нет');
});

check('справки на экране нет — без кнопки, строка остаётся', () => {
  const handler = questionHandler({
    card: null,
    stepCard: 'greeting-brief-card',
    canOpenHelp: false,
  });
  const plan = handler(
    { kind: 'question', topic: null, answered: false },
    ctx,
    result({ kind: 'question', topic: null, answered: false }, null)
  );
  eq(plan.kind === 'answer' && plan.help, null);
  // Сервер не прислал строку — запасная «не понял», а не пустота.
  eq(plan.kind === 'answer' && plan.text, 'не понял');
});

check('«отвечено» без текста ответа — не озвучивается как отвеченное', () => {
  const plan = questionHandler({
    card: null,
    stepCard: 'greeting-video-card',
    canOpenHelp: true,
  })(
    { kind: 'question', topic: 'how-long', answered: true },
    ctx,
    result({ kind: 'question', topic: 'how-long', answered: true }, null)
  );
  eq(plan.kind === 'answer' && plan.answered, false);
  eq(plan.kind === 'answer' && plan.topic, null);
});

// ── CONTRACT5: очередь, теги плеера, поводы до голоса ────────────────

check('очередь: тихо — сразу; занято — ждёт конца, не обрывает', () => {
  const played: string[] = [];
  const player = {
    playing: false,
    play(url: string, tag: string) {
      played.push(`${tag}:${url}`);
      this.playing = true;
    },
  };
  const q = createSpeechQueue(player);
  eq(q.say('a', 'hint', 0), 'now');
  eq(q.say('b', 'proactive', 100), 'queued');
  eq(played, ['hint:a']);
  player.playing = false;
  q.idle(1000);
  eq(played, ['hint:a', 'proactive:b']);
});

check('очередь: один слот — новая ожидающая вытесняет прежнюю', () => {
  const played: string[] = [];
  const player = {
    playing: true,
    play(url: string) {
      played.push(url);
    },
  };
  const q = createSpeechQueue(player);
  q.say('b', 'proactive', 0);
  q.say('c', 'proactive', 10);
  q.idle(20);
  eq(played, ['c']);
  q.idle(30);
  eq(played, ['c']);
});

check('очередь: устаревшая ожидающая выбрасывается', () => {
  const played: string[] = [];
  const player = {
    playing: true,
    play(url: string) {
      played.push(url);
    },
  };
  const q = createSpeechQueue(player);
  q.say('late', 'proactive', 0);
  q.idle(SPEECH_STALE_MS + 1);
  eq(played, []);
  q.say('fresh', 'proactive', 0);
  q.idle(SPEECH_STALE_MS);
  eq(played, ['fresh']);
});

check(
  'очередь: уход с шага снимает ожидающую подсказку, но не проактивную',
  () => {
    const player = { playing: true, play() {} };
    const q = createSpeechQueue(player);
    q.say('h', 'hint', 0);
    q.drop('proactive');
    eq(q.pending?.url, 'h');
    q.drop('hint');
    eq(q.pending, null);
    q.say('p', 'proactive', 0);
    q.drop('hint');
    eq(q.pending?.url, 'p');
    q.drop();
    eq(q.pending, null);
  }
);

check('плеер: stopTag глушит только реплику своего тега', () => {
  const el: AudioLike = {
    src: '',
    muted: false,
    currentTime: 0,
    play: () => Promise.resolve(),
    pause: () => undefined,
  };
  const p = createHintPlayer(() => el);
  p.play('https://blob/p.mp3', 'proactive');
  eq(p.currentTag, 'proactive');
  p.stopTag('hint');
  eq(p.playing, true);
  p.stopTag('proactive');
  eq(p.playing, false);
  eq(p.currentTag, null);
  p.play('https://blob/h.mp3');
  eq(p.currentTag, 'hint');
});

check(
  'помеченный сценарий строкой не расходуется — ждёт голоса, потом один раз',
  () => {
    const m = createProactiveMemory();
    const e = {
      kind: 'refusal',
      refusal: 'moderation',
      key: 's1:p1',
    } as const;
    eq(proactiveDecision(e, 'text', m, 0), { speak: false, line: false });
    eq(proactiveDecision(e, 'text', m, 1), { speak: false, line: false });
    eq(proactiveDecision(e, 'voice', m, 2), { speak: true, line: false });
    eq(proactiveDecision(e, 'voice', m, 99_999), { speak: false, line: false });
    // Другой сценарий — другой ключ.
    eq(proactiveDecision({ ...e, key: 's1:p2' }, 'voice', m, 3).speak, true);
  }
);

check('прочие поводы строкой расходуются; «готов» — строкой и в тексте', () => {
  const m = createProactiveMemory();
  const ready = { kind: 'video-ready', sessionId: 's1' } as const;
  eq(proactiveDecision(ready, 'text', m, 0), { speak: false, line: true });
  eq(proactiveDecision(ready, 'voice', m, 1), { speak: false, line: false });
  const q = { kind: 'refusal', refusal: 'quota' } as const;
  eq(proactiveDecision(q, 'text', m, 0).speak, false);
  eq(proactiveDecision(q, 'voice', m, 1).speak, false);
});

check('«не знаю» — тоже речь: ответ без темы', () => {
  eq(speakBodyOf({ kind: 'answer', topic: null, language: 'de' }, 'ru'), {
    kind: 'answer',
    topic: null,
    locale: 'de',
  });
});

if (failed) {
  console.error(`\n${failed} проверок упало`);
  process.exit(1);
}
console.log(`\n${passed} проверок пройдено`);
