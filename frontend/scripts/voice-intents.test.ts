// Plain assertions runnable with `npx tsx scripts/voice-intents.test.ts`.
//
// Этап K3 ТЗ Greeting 2.0 §4А.2, §4А.7: разбор реплики → план экрана.

import {
  K3_INTENT_HANDLERS,
  dispatchVoiceResult,
  withIntentHandler,
  type VoiceDispatchContext,
} from '../src/lib/voice-intents';
import type {
  VoiceIntent,
  VoiceUnderstandResult,
} from '../src/lib/voice-types';

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

const texts = {
  unknown: 'UNKNOWN',
  manual: 'MANUAL',
  nothingPending: 'NOTHING',
};
const ctx = (
  over: Partial<VoiceDispatchContext> = {}
): VoiceDispatchContext => ({
  hasPending: false,
  canFill: (t) => t.startsWith('greeting-field-'),
  command: () => null,
  texts,
  ...over,
});
const result = (
  intent: VoiceIntent | null,
  reply: string | null = null
): VoiceUnderstandResult => ({
  status: 'ok',
  transcript: 'x',
  language: 'ru',
  intent,
  confidence: 0.9,
  reply,
  scriptMismatch: false,
});
const R = K3_INTENT_HANDLERS;

const name = {
  target: 'greeting-field-recipient',
  value: 'Мама',
  label: 'Кому',
};
const foreign = {
  target: 'greeting-sticker-toggle',
  value: true,
  label: 'Наклейка',
};

check('fill → карточка только с полями, которые экран умеет', () => {
  eq(
    dispatchVoiceResult(
      result({ kind: 'fill', fields: [name, foreign] }),
      R,
      ctx()
    ),
    {
      kind: 'propose',
      card: { kind: 'fill', fields: [name] },
    }
  );
});

check('fill без знакомых полей → ответ сервера, иначе «не понял»', () => {
  const r = result({ kind: 'fill', fields: [foreign] });
  eq(dispatchVoiceResult(r, R, ctx()), { kind: 'reply', text: 'UNKNOWN' });
  eq(
    dispatchVoiceResult({ ...r, reply: 'Наклейку — на шаге видео' }, R, ctx()),
    { kind: 'reply', text: 'Наклейку — на шаге видео' }
  );
});

check('confirm/cancel — только при карточке на экране', () => {
  eq(
    dispatchVoiceResult(
      result({ kind: 'confirm' }),
      R,
      ctx({ hasPending: true })
    ),
    {
      kind: 'confirm',
    }
  );
  eq(
    dispatchVoiceResult(
      result({ kind: 'cancel' }),
      R,
      ctx({ hasPending: true })
    ),
    {
      kind: 'cancel',
    }
  );
  eq(dispatchVoiceResult(result({ kind: 'confirm' }), R, ctx()), {
    kind: 'reply',
    text: 'NOTHING',
  });
  eq(dispatchVoiceResult(result({ kind: 'cancel' }), R, ctx()), {
    kind: 'reply',
    text: 'NOTHING',
  });
});

check('command с обработчиком → его карточка или его отказ', () => {
  const card = {
    kind: 'fill' as const,
    fields: [{ target: 'greeting-field-tone', value: 'FORMAL', label: 'Тон' }],
  };
  const seen: string[] = [];
  const withTone = ctx({
    command: (c) => {
      seen.push(c);
      return c === 'tone-serious'
        ? { kind: 'propose', card }
        : { kind: 'refuse', text: 'недоступен' };
    },
  });
  eq(
    dispatchVoiceResult(
      result({ kind: 'command', command: 'tone-serious' }),
      R,
      withTone
    ),
    { kind: 'propose', card }
  );
  eq(
    dispatchVoiceResult(
      result({ kind: 'command', command: 'tone-lighter' }),
      R,
      withTone
    ),
    { kind: 'reply', text: 'недоступен' }
  );
  eq(seen, ['tone-serious', 'tone-lighter']);
});

check('command без обработчика → «пока руками»', () => {
  eq(
    dispatchVoiceResult(
      result({ kind: 'command', command: 'shorter' }),
      R,
      ctx()
    ),
    {
      kind: 'reply',
      text: 'MANUAL',
    }
  );
});

check('unknown → переспрос сервера (названием поля), иначе «не понял»', () => {
  eq(
    dispatchVoiceResult(
      result({ kind: 'unknown' }, 'Не расслышал имя получателя'),
      R,
      ctx()
    ),
    { kind: 'reply', text: 'Не расслышал имя получателя' }
  );
  eq(dispatchVoiceResult(result({ kind: 'unknown' }), R, ctx()), {
    kind: 'reply',
    text: 'UNKNOWN',
  });
  eq(dispatchVoiceResult(result(null), R, ctx()), {
    kind: 'reply',
    text: 'UNKNOWN',
  });
});

check('интент без обработчика (волна 2) — не молча: «пока руками»', () => {
  for (const intent of [
    { kind: 'navigate', to: 'next' },
    { kind: 'help' },
    { kind: 'consent', phrase: 'генерируй' },
  ] as VoiceIntent[]) {
    eq(dispatchVoiceResult(result(intent), R, ctx()), {
      kind: 'reply',
      text: 'MANUAL',
    });
  }
});

check('реестр расширяется без правки K3 — и не мутирует исходный', () => {
  const extended = withIntentHandler(R, 'navigate', (intent) => ({
    kind: 'reply',
    text: `go:${intent.to}`,
  }));
  eq(
    dispatchVoiceResult(
      result({ kind: 'navigate', to: 'script' }),
      extended,
      ctx()
    ),
    {
      kind: 'reply',
      text: 'go:script',
    }
  );
  eq(R.navigate, undefined);
  // Обработчики K3 в расширенном реестре на месте.
  eq(
    dispatchVoiceResult(
      result({ kind: 'confirm' }),
      extended,
      ctx({ hasPending: true })
    ),
    {
      kind: 'confirm',
    }
  );
});

console.log(failed ? `\n${failed} провалено` : `\n${passed} проверок пройдено`);
if (failed) process.exit(1);
