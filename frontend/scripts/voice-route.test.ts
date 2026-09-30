// Plain assertions runnable with `npx tsx scripts/voice-route.test.ts`.
//
// Финальный аудит ветки K: порядок разбора ответа на клиенте — потолок →
// устаревший ответ → статус → согласие → реестр интентов — вынесен из
// `VoiceAssistant` в чистую функцию и проверяется здесь.

import { K3_INTENT_HANDLERS } from '../src/lib/voice-intents';
import {
  planLine,
  routeVoiceResult,
  screenCurrentOf,
  type VoiceRouteConsentTarget,
  type VoiceRouteDeps,
} from '../src/lib/voice-route';
import type {
  VoiceIntent,
  VoiceUnderstandResult,
} from '../src/lib/voice-types';

let failed = 0;
let passed = 0;
let queue: Promise<void> = Promise.resolve();
function check(name: string, fn: () => void | Promise<void>) {
  queue = queue.then(async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
    }
  });
}
function eq(a: unknown, b: unknown) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${x} !== ${y}`);
}

const res = (
  over: Partial<VoiceUnderstandResult> & { intent?: VoiceIntent | null } = {}
): VoiceUnderstandResult => ({
  status: 'ok',
  transcript: 'сказано',
  language: 'ru',
  intent: null,
  confidence: 0.9,
  reply: null,
  scriptMismatch: false,
  ...over,
});

/** Зависимости с журналом вызовов. */
function deps(over: Partial<VoiceRouteDeps> = {}) {
  const log: string[] = [];
  const d: VoiceRouteDeps = {
    isCurrent: () => true,
    hasPendingCard: () => false,
    consentTarget: () => null,
    markBudgetExhausted: () => log.push('mark'),
    claimBudgetNotice: () => {
      log.push('claim');
      return true;
    },
    onHeard: (t) => log.push(`heard:${t}`),
    handlers: () => K3_INTENT_HANDLERS,
    dispatch: {
      canFill: (t) => t.startsWith('greeting-field-'),
      command: () => null,
      texts: { unknown: 'UNKNOWN', manual: 'MANUAL', nothingPending: 'NONE' },
    },
    texts: {
      notHeard: 'NOT_HEARD',
      unavailable: 'UNAVAILABLE',
      budgetExhausted: 'BUDGET',
      tooLong: 'TOO_LONG',
      noButton: 'NO_BUTTON',
      sayHint: 'SAY_HINT',
    },
    ...over,
  };
  return { d, log };
}

function target(
  over: Partial<VoiceRouteConsentTarget> = {},
  log: string[] = []
): VoiceRouteConsentTarget {
  return {
    isOpen: () => false,
    consent: async () => {
      log.push('consent');
      return { text: 'SUMMARY', tone: 'info' };
    },
    cancel: () => {
      log.push('cancel');
      return { text: 'CLOSED', tone: 'info' };
    },
    interrupt: () => log.push('interrupt'),
    ...over,
  };
}

check('потолок запоминается даже из устаревшего ответа', async () => {
  const { d, log } = deps({ isCurrent: () => false });
  eq(await routeVoiceResult(res({ status: 'budget-exhausted' }), d), {
    kind: 'stale',
  });
  // Помечен, но ни «услышано», ни права сказать не взято.
  eq(log, ['mark']);
});

check('устаревший ответ — никуда, даже согласие', async () => {
  const log: string[] = [];
  const { d } = deps({
    isCurrent: () => false,
    consentTarget: () => target({}, log),
  });
  const out = await routeVoiceResult(
    res({ intent: { kind: 'consent', phrase: 'генерируй' } }),
    d
  );
  eq(out, { kind: 'stale' });
  eq(log, []);
});

check('потолок: строка с правом сказать, микрофон — до завтра', async () => {
  const { d, log } = deps();
  eq(await routeVoiceResult(res({ status: 'budget-exhausted' }), d), {
    kind: 'status',
    line: { text: 'BUDGET', tone: 'warning' },
    stop: 'today',
  });
  eq(log, ['mark', 'heard:сказано', 'claim']);
  // Право уже взял другой канал — без строки, но микрофон гаснет.
  const other = deps({ claimBudgetNotice: () => false });
  eq(await routeVoiceResult(res({ status: 'budget-exhausted' }), other.d), {
    kind: 'status',
    line: null,
    stop: 'today',
  });
});

check('обычный ответ не отнимает право сказать о потолке', async () => {
  const { d, log } = deps();
  await routeVoiceResult(res({ status: 'not-heard' }), d);
  await routeVoiceResult(res({ intent: { kind: 'unknown' } }), d);
  eq(log.includes('claim'), false);
});

check('причина отказа: до нажатия / слушать дальше', async () => {
  const { d } = deps();
  eq(
    await routeVoiceResult(
      res({ status: 'unavailable', reply: 'ВЫКЛ', reason: 'operator-off' }),
      d
    ),
    {
      kind: 'status',
      line: { text: 'ВЫКЛ', tone: 'warning' },
      stop: 'until-tap',
    }
  );
  eq(
    await routeVoiceResult(
      res({ status: 'unavailable', reply: 'КОРОЧЕ', reason: 'too-long' }),
      d
    ),
    {
      kind: 'status',
      line: { text: 'КОРОЧЕ', tone: 'warning' },
      stop: null,
    }
  );
  eq(await routeVoiceResult(res({ status: 'not-heard' }), d), {
    kind: 'status',
    line: { text: 'NOT_HEARD', tone: 'info' },
    stop: null,
  });
});

check('согласие — владельцу кнопки, мимо реестра', async () => {
  const log: string[] = [];
  const { d } = deps({ consentTarget: () => target({}, log) });
  eq(
    await routeVoiceResult(
      res({ intent: { kind: 'consent', phrase: 'генерируй' } }),
      d
    ),
    { kind: 'line', line: { text: 'SUMMARY', tone: 'info' } }
  );
  eq(log, ['consent']);
  // Кнопки нет — строка «генерировать нечего».
  const none = deps();
  eq(
    await routeVoiceResult(
      res({ intent: { kind: 'consent', phrase: 'генерируй' } }),
      none.d
    ),
    { kind: 'line', line: { text: 'NO_BUTTON', tone: 'info' } }
  );
});

check('согласие устарело, пока ждали цену — строки нет', async () => {
  let current = true;
  const { d } = deps({
    isCurrent: () => current,
    consentTarget: () =>
      target({
        consent: async () => {
          current = false;
          return { text: 'SUMMARY', tone: 'info' };
        },
      }),
  });
  eq(
    await routeVoiceResult(
      res({ intent: { kind: 'consent', phrase: 'генерируй' } }),
      d
    ),
    { kind: 'stale' }
  );
});

check(
  'открытая сводка: «нет» — ей, «да» — подсказка, поле — прерывает',
  async () => {
    const log: string[] = [];
    const t = target({ isOpen: () => true }, log);
    const { d } = deps({ consentTarget: () => t });
    eq(await routeVoiceResult(res({ intent: { kind: 'cancel' } }), d), {
      kind: 'line',
      line: { text: 'CLOSED', tone: 'info' },
    });
    eq(await routeVoiceResult(res({ intent: { kind: 'confirm' } }), d), {
      kind: 'line',
      line: { text: 'SAY_HINT', tone: 'info' },
    });
    const fill = await routeVoiceResult(
      res({
        intent: {
          kind: 'fill',
          fields: [
            {
              target: 'greeting-field-recipient',
              value: 'Анна',
              label: 'Кому',
            },
          ],
        },
      }),
      d
    );
    eq(fill.kind, 'plan');
    eq(log, ['cancel', 'interrupt']);
  }
);

check(
  'переход при открытой сводке — не прерывает её (финальный аудит)',
  async () => {
    const log: string[] = [];
    const { d } = deps({
      consentTarget: () => target({ isOpen: () => true }, log),
      handlers: () => ({
        ...K3_INTENT_HANDLERS,
        navigate: () => ({ kind: 'navigate', step: 'script' }),
      }),
    });
    eq(
      await routeVoiceResult(
        res({ intent: { kind: 'navigate', to: 'script' } }),
        d
      ),
      { kind: 'plan', plan: { kind: 'navigate', step: 'script' } }
    );
    eq(log, []);
  }
);

check(
  'карточка на экране читается в момент решения, а не заранее',
  async () => {
    let pending = false;
    const { d } = deps({ hasPendingCard: () => pending });
    pending = true;
    eq(await routeVoiceResult(res({ intent: { kind: 'confirm' } }), d), {
      kind: 'plan',
      plan: { kind: 'confirm' },
    });
    pending = false;
    eq(await routeVoiceResult(res({ intent: { kind: 'confirm' } }), d), {
      kind: 'plan',
      plan: { kind: 'reply', text: 'NONE' },
    });
  }
);

check('planLine: строка к плану', () => {
  const card = { kind: 'fill' as const, fields: [] };
  eq(planLine({ kind: 'propose', card }, { reply: 'тон недоступен' }), {
    text: 'тон недоступен',
    tone: 'info',
  });
  eq(planLine({ kind: 'propose', card }, { reply: null }), null);
  eq(planLine({ kind: 'confirm' }, { reply: 'x' }), 'keep');
  eq(planLine({ kind: 'cancel' }, { reply: 'x' }), null);
  eq(planLine({ kind: 'reply', text: 'R' }, { reply: 'x' }), {
    text: 'R',
    tone: 'info',
  });
  eq(planLine({ kind: 'navigate', step: 'brief' }, { reply: null }), null);
  eq(
    planLine({ kind: 'navigate', step: 'brief', text: 'N' }, { reply: null }),
    {
      text: 'N',
      tone: 'info',
    }
  );
});

check(
  'current: только известные ключи; пустое — null; брифа нет — поля нет',
  () => {
    eq(screenCurrentOf(null), undefined);
    eq(screenCurrentOf({}), undefined);
    eq(
      screenCurrentOf({
        occasion: 'BIRTHDAY',
        recipientName: '',
        tone: null,
        // Не строка и чужой ключ — не отправляются.
        mood: 5 as unknown as string,
        ...({ extra: 'x' } as object),
      }),
      { occasion: 'BIRTHDAY', tone: null, recipientName: null }
    );
  }
);

void queue.then(() => {
  console.log(
    failed ? `\n${failed} провалено` : `\n${passed} проверок пройдено`
  );
  if (failed) process.exit(1);
});
