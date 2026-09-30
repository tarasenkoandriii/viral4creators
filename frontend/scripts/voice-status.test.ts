// Plain assertions runnable with `npx tsx scripts/voice-status.test.ts`.
//
// Этап K3 ТЗ Greeting 2.0 §4А.3 («Тишина, шум, обрывок»), §4А.7.5 (В-14):
// статус реплики → строка и судьба микрофона. Память о потолке (сутки
// UTC, «один раз») — общая с советником и проверяется у него
// (`hint-audio.ts`); здесь — только решение по статусу.

import {
  serverMessageOf,
  uploadRefusalOf,
  voiceResultOfError,
  voiceResultOfStatus,
  voiceStatusOutcome,
} from '../src/lib/voice-status';
import type { VoiceReason } from '../src/lib/voice-types';

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
  tooLong: 'TOO_LONG',
};
const r = (
  status: 'ok' | 'not-heard' | 'unavailable' | 'budget-exhausted',
  reply: string | null = null,
  reason: VoiceReason | null = null
) => ({ status, reply, reason });

check('ok — не статус, а разбор: строки нет', () => {
  eq(voiceStatusOutcome(r('ok'), texts, false), null);
});

check('не расслышал — всегда наша строка, микрофон живёт', () => {
  eq(voiceStatusOutcome(r('not-heard', 'что-то'), texts, false), {
    text: 'NOT_HEARD',
    tone: 'info',
    stopForToday: false,
    stopUntilTap: false,
  });
});

check(
  'недоступно — причина сервера, если есть, иначе наша; не на сутки',
  () => {
    eq(voiceStatusOutcome(r('unavailable'), texts, false), {
      text: 'UNAVAILABLE',
      tone: 'warning',
      stopForToday: false,
      stopUntilTap: false,
    });
    eq(
      voiceStatusOutcome(
        r('unavailable', 'Войдите, чтобы говорить'),
        texts,
        false
      ),
      {
        text: 'Войдите, чтобы говорить',
        tone: 'warning',
        stopForToday: false,
        stopUntilTap: false,
      }
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
      stopUntilTap: false,
    });
    eq(voiceStatusOutcome(r('budget-exhausted'), texts, false), {
      text: null,
      tone: 'warning',
      stopForToday: true,
      stopUntilTap: false,
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

check(
  'причина: оператор/вход/лимит аккаунта — гасить до нажатия; длинная — слушать',
  () => {
    for (const reason of [
      'operator-off',
      'login-required',
      'account-limit',
    ] as const) {
      eq(
        voiceStatusOutcome(r('unavailable', 'ПРИЧИНА', reason), texts, false),
        {
          text: 'ПРИЧИНА',
          tone: 'warning',
          stopForToday: false,
          stopUntilTap: true,
        }
      );
    }
    eq(
      voiceStatusOutcome(r('unavailable', 'КОРОЧЕ', 'too-long'), texts, false),
      {
        text: 'КОРОЧЕ',
        tone: 'warning',
        stopForToday: false,
        stopUntilTap: false,
      }
    );
    // Без `reply` — наша общая строка, судьба микрофона та же.
    eq(
      voiceStatusOutcome(r('unavailable', null, 'operator-off'), texts, false)
        ?.text,
      'UNAVAILABLE'
    );
  }
);

check('длинная без строки сервера — наша «короче», не «недоступно»', () => {
  eq(voiceStatusOutcome(r('unavailable', null, 'too-long'), texts, false), {
    text: 'TOO_LONG',
    tone: 'warning',
    stopForToday: false,
    stopUntilTap: false,
  });
});

check(
  'ссылку не выдали по размеру (400) — «слишком длинно» по признаку, не по тексту',
  () => {
    const tooLong = uploadRefusalOf(400, {
      error: {
        message: 'Запись длиннее минуты — реплика должна быть короче',
        details: { reason: 'too-long' },
      },
    });
    eq(
      [tooLong?.status, tooLong?.reason, tooLong?.reply],
      ['unavailable', 'too-long', null]
    );
    // Код в details — тоже признак.
    eq(
      uploadRefusalOf(400, {
        error: { message: 'x', details: { code: 'VOICE_TOO_LONG' } },
      })?.reason,
      'too-long'
    );
    // Текст без признака — уже НЕ «слишком длинно» (CONTRACT6 G-FE п. 13).
    eq(
      uploadRefusalOf(400, {
        error: {
          message: 'Запись длиннее минуты — реплика должна быть короче',
        },
      }),
      null
    );
    eq(
      uploadRefusalOf(400, {
        message: ['fileSize must not be greater than 4194304'],
      }),
      null
    );
    // Другая 400 и другой код — не про длину.
    eq(
      uploadRefusalOf(400, {
        error: { message: 'mimeType не подходит', details: { code: 'OTHER' } },
      }),
      null
    );
    eq(
      uploadRefusalOf(403, {
        error: { message: 'x', details: { reason: 'too-long' } },
      }),
      null
    );
    eq(uploadRefusalOf(400, null), null);
  }
);

console.log(failed ? `\n${failed} провалено` : `\n${passed} проверок пройдено`);
if (failed) process.exit(1);
