// Plain assertions runnable with `npx tsx scripts/voice-status.test.ts`.
//
// Этап K3 ТЗ Greeting 2.0 §4А.3 («Тишина, шум, обрывок»), §4А.7.5 (В-14):
// статус реплики → строка и судьба микрофона. Память о потолке (сутки
// UTC, «один раз») — общая с советником и проверяется у него
// (`hint-audio.ts`); здесь — только решение по статусу.

import {
  serverMessageOf,
  voiceResultOfError,
  voiceResultOfStatus,
  voiceStatusOutcome,
} from '../src/lib/voice-status';

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
  notHeard: 'NOT_HEARD',
  unavailable: 'UNAVAILABLE',
  budgetExhausted: 'BUDGET',
};
const r = (
  status: 'ok' | 'not-heard' | 'unavailable' | 'budget-exhausted',
  reply: string | null = null
) => ({ status, reply });

check('ok — не статус, а разбор: строки нет', () => {
  eq(voiceStatusOutcome(r('ok'), texts, false), null);
});

check('не расслышал — всегда наша строка, микрофон живёт', () => {
  eq(voiceStatusOutcome(r('not-heard', 'что-то'), texts, false), {
    text: 'NOT_HEARD',
    tone: 'info',
    stopForToday: false,
  });
});

check(
  'недоступно — причина сервера, если есть, иначе наша; не на сутки',
  () => {
    eq(voiceStatusOutcome(r('unavailable'), texts, false), {
      text: 'UNAVAILABLE',
      tone: 'warning',
      stopForToday: false,
    });
    eq(
      voiceStatusOutcome(
        r('unavailable', 'Войдите, чтобы говорить'),
        texts,
        false
      ),
      { text: 'Войдите, чтобы говорить', tone: 'warning', stopForToday: false }
    );
  }
);

check(
  'потолок: строка — только с правом сказать, микрофон гаснет всегда',
  () => {
    eq(voiceStatusOutcome(r('budget-exhausted'), texts, true), {
      text: 'BUDGET',
      tone: 'warning',
      stopForToday: true,
    });
    eq(voiceStatusOutcome(r('budget-exhausted'), texts, false), {
      text: null,
      tone: 'warning',
      stopForToday: true,
    });
  }
);

check('сбой запроса — «недоступно», НИКОГДА не потолок (403 тоже)', () => {
  const failed = voiceResultOfError('Голос закрыт оператором');
  eq(failed.status, 'unavailable');
  eq(failed.reply, 'Голос закрыт оператором');
  eq(voiceStatusOutcome(failed, texts, true)?.stopForToday, false);
  eq(voiceResultOfError(null).reply, null);
  eq(voiceResultOfError('   ').reply, null);
});

check('сообщение сервера из конверта ошибки', () => {
  eq(serverMessageOf({ error: { code: 'X', message: 'нет' } }), 'нет');
  eq(serverMessageOf({ message: 'Forbidden' }), 'Forbidden');
  eq(serverMessageOf({ message: ['a', 'b'] }), null);
  eq(serverMessageOf('<html>'), null);
  eq(serverMessageOf(undefined), null);
});

check('пустой разбор со статусом — без интента и текста', () => {
  eq(voiceResultOfStatus('unavailable'), {
    status: 'unavailable',
    transcript: null,
    language: null,
    intent: null,
    confidence: 0,
    reply: null,
    scriptMismatch: false,
  });
});

console.log(failed ? `\n${failed} провалено` : `\n${passed} проверок пройдено`);
if (failed) process.exit(1);
