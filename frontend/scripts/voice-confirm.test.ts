// Plain assertions runnable with `npx tsx scripts/voice-confirm.test.ts`.
//
// Этап K3 ТЗ Greeting 2.0 §4А.2 п. 3: карточка «я понял так» — ничего не
// применяется без «Да».

import {
  CONFIRM_INITIAL,
  applyOutcomeLine,
  confirmReducer,
  mergeFields,
  pendingForServer,
  type VoiceCard,
} from '../src/lib/voice-confirm';

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

const recipient = {
  target: 'greeting-field-recipient',
  value: 'Мама',
  label: 'Кому',
};
const occasion = {
  target: 'greeting-field-occasion',
  value: 'BIRTHDAY',
  label: 'Повод',
};
const fill: VoiceCard = { kind: 'fill', fields: [occasion, recipient] };
const action: VoiceCard = {
  kind: 'action',
  command: 'regenerate-script',
  label: 'Пересобрать сценарий',
};

check('предложение показывается, но НЕ применяется', () => {
  const r = confirmReducer(CONFIRM_INITIAL, { type: 'propose', card: fill });
  eq(r.state.card, fill);
  eq(r.apply, null);
});

check('«Да» применяет ровно показанное и снимает карточку', () => {
  const shown = confirmReducer(CONFIRM_INITIAL, {
    type: 'propose',
    card: fill,
  });
  const r = confirmReducer(shown.state, { type: 'confirm' });
  eq(r.apply, fill);
  eq(r.state.card, null);
});

check('«Нет» снимает карточку без применения', () => {
  const shown = confirmReducer(CONFIRM_INITIAL, {
    type: 'propose',
    card: fill,
  });
  const r = confirmReducer(shown.state, { type: 'cancel' });
  eq([r.state.card, r.apply], [null, null]);
});

check('«Да» без карточки ничего не применяет', () => {
  eq(confirmReducer(CONFIRM_INITIAL, { type: 'confirm' }).apply, null);
});

check(
  'уточнение поверх карточки: поле заменяется на месте, новое дописывается',
  () => {
    const shown = confirmReducer(CONFIRM_INITIAL, {
      type: 'propose',
      card: fill,
    });
    const fixed = { ...recipient, value: 'Анна' };
    const sender = {
      target: 'greeting-field-sender',
      value: 'Андрей',
      label: 'От кого',
    };
    const r = confirmReducer(shown.state, {
      type: 'propose',
      card: { kind: 'fill', fields: [fixed, sender] },
    });
    eq(r.state.card, { kind: 'fill', fields: [occasion, fixed, sender] });
  }
);

check('действие вытесняет поля (и наоборот) — не смешиваются', () => {
  const shown = confirmReducer(CONFIRM_INITIAL, {
    type: 'propose',
    card: fill,
  });
  eq(
    confirmReducer(shown.state, { type: 'propose', card: action }).state.card,
    action
  );
  const back = confirmReducer(
    { card: action },
    { type: 'propose', card: fill }
  );
  eq(back.state.card, fill);
});

check('mergeFields не мутирует исходные списки', () => {
  const a = [recipient];
  const b = [{ ...recipient, value: 'X' }];
  mergeFields(a, b);
  eq(a[0].value, 'Мама');
});

check(
  'pending для сервера: поля карточки; у действия — пустой список; нет — нет',
  () => {
    eq(pendingForServer({ card: fill }), {
      kind: 'fill',
      fields: [occasion, recipient],
    });
    eq(pendingForServer({ card: action }), { kind: 'fill', fields: [] });
    eq(pendingForServer(CONFIRM_INITIAL), undefined);
  }
);

const applyTexts = {
  applied: 'APPLIED',
  nothingApplied: 'NOTHING',
  actionStarted: 'START {action}',
  actionStale: 'STALE',
  saved: 'SAVED',
  filledNeedsSave: 'PRESS «{button}»',
  notSaved: 'NOT SAVED: {reason}.',
};

check('строка после «Да» — по тому, что применилось на самом деле', () => {
  eq(applyOutcomeLine({ kind: 'fill', applied: 2, refusals: [] }, applyTexts), {
    text: 'APPLIED',
    tone: 'success',
  });
  // Владельца полей уже нет — «готово» было бы неправдой.
  eq(applyOutcomeLine({ kind: 'fill', applied: 0, refusals: [] }, applyTexts), {
    text: 'NOTHING',
    tone: 'warning',
  });
  eq(
    applyOutcomeLine(
      { kind: 'fill', applied: 1, refusals: ['R1'] },
      applyTexts
    ),
    { text: 'APPLIED R1', tone: 'warning' }
  );
  eq(
    applyOutcomeLine(
      { kind: 'fill', applied: 0, refusals: ['R1', 'R2'] },
      applyTexts
    ),
    { text: 'R1 R2', tone: 'warning' }
  );
});

check(
  'K5: строка — по отчёту владельца: сохранено / нажмите / не сохранилось',
  () => {
    eq(
      applyOutcomeLine(
        { kind: 'fill', applied: 1, refusals: [], saved: true },
        applyTexts
      ),
      { text: 'SAVED', tone: 'success' }
    );
    eq(
      applyOutcomeLine(
        {
          kind: 'fill',
          applied: 2,
          refusals: [],
          needsSave: ['Сохранить текст', 'Найти'],
        },
        applyTexts
      ),
      { text: 'PRESS «Сохранить текст» PRESS «Найти»', tone: 'success' }
    );
    // Сохранение не прошло — не «Готово», а причина экрана (без двойной точки).
    eq(
      applyOutcomeLine(
        {
          kind: 'fill',
          applied: 1,
          refusals: [],
          failures: ['Сеть недоступна.'],
        },
        applyTexts
      ),
      { text: 'NOT SAVED: Сеть недоступна.', tone: 'warning' }
    );
    eq(
      applyOutcomeLine(
        {
          kind: 'fill',
          applied: 1,
          refusals: ['R1'],
          saved: true,
          needsSave: ['Найти'],
        },
        applyTexts
      ),
      { text: 'SAVED PRESS «Найти» R1', tone: 'warning' }
    );
    // Отчёт есть — старое «Заполнил … бриф» не появляется.
    eq(
      applyOutcomeLine(
        { kind: 'fill', applied: 1, refusals: [], needsSave: ['Сохранить'] },
        applyTexts
      ).text.includes('APPLIED'),
      false
    );
  }
);

check('действие: запущено — названо; обработчика нет — честный отказ', () => {
  eq(
    applyOutcomeLine(
      { kind: 'action', ran: true, label: 'Пересобрать' },
      applyTexts
    ),
    { text: 'START Пересобрать', tone: 'success' }
  );
  eq(
    applyOutcomeLine(
      { kind: 'action', ran: false, label: 'Пересобрать' },
      applyTexts
    ),
    { text: 'STALE', tone: 'warning' }
  );
});

console.log(failed ? `\n${failed} провалено` : `\n${passed} проверок пройдено`);
if (failed) process.exit(1);
