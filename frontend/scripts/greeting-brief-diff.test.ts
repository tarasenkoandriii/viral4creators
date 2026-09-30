// Plain assertions runnable with `npx tsx scripts/greeting-brief-diff.test.ts`.
//
// Этап C ТЗ Greeting 2.0 (§3.6): после старта сессии бриф уходит только
// изменёнными полями.

import {
  briefSaveState,
  changedBriefFields,
  sessionBriefPatch,
  startAfterSave,
} from '../src/lib/greeting-brief-diff';

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

const base = {
  occasion: 'BIRTHDAY',
  recipientName: 'Марина',
  senderName: null,
  presenterProvider: 'hedra',
  scriptLanguage: 'ru',
};

check('без правок — пустое тело', () => {
  eq(changedBriefFields(base, { ...base }), {});
});

check(
  'опечатка в имени не тащит за собой провайдера (тариф не перепроверяется)',
  () => {
    eq(changedBriefFields(base, { ...base, recipientName: 'Марине' }), {
      recipientName: 'Марине',
    });
  }
);

check('очистка поля — это правка, и уходит как null', () => {
  eq(changedBriefFields({ ...base, senderName: 'Андрей' }, { ...base }), {
    senderName: null,
  });
});

check('язык отправляется, только если его сменили', () => {
  eq(changedBriefFields(base, { ...base, scriptLanguage: 'de' }), {
    scriptLanguage: 'de',
  });
});

// ── Тело правки сессии: ответ о настроении «Особого повода» всегда ────

const other: Record<string, string | null> = {
  occasion: 'OTHER',
  customOccasionText: 'Поминки дедушки',
  occasionRegister: 'CELEBRATORY',
  recipientName: 'Марина',
  scriptLanguage: 'ru',
};

check('«Особый повод»: ответ о настроении уходит и без его правки', () => {
  // Сервер поднял регистр словом «поминки» (`registerSource:
  // 'keywords'`) — ответа человека в брифе нет, и без поля в теле
  // `resolveNext` получил бы `userRegister = null` → 400
  // OTHER_MOOD_REQUIRED на исправлении опечатки в имени.
  eq(sessionBriefPatch(other, { ...other, recipientName: 'Марине' }), {
    recipientName: 'Марине',
    occasionRegister: 'CELEBRATORY',
  });
  eq(sessionBriefPatch(other, { ...other }), {
    occasionRegister: 'CELEBRATORY',
  });
});

check('повод из списка — только изменённые поля', () => {
  eq(sessionBriefPatch(base, { ...base, recipientName: 'Марине' }), {
    recipientName: 'Марине',
  });
});

check('ушли с «Особого» — очистка ответа уходит как правка', () => {
  eq(
    sessionBriefPatch(other, {
      ...other,
      occasion: 'BIRTHDAY',
      customOccasionText: null,
      occasionRegister: null,
    }),
    { occasion: 'BIRTHDAY', customOccasionText: null, occasionRegister: null }
  );
});

// ── «Начать» после неудачного сохранения ────────────────────────────────

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}

await checkAsync('бриф не сохранился — сессия не начинается', async () => {
  let started = false;
  const ok = await startAfterSave(
    async () => false,
    async () => {
      started = true;
    }
  );
  eq([ok, started], [false, false]);
});

await checkAsync('бриф сохранился — сессия начинается', async () => {
  let started = false;
  const ok = await startAfterSave(
    async () => true,
    async () => {
      started = true;
    }
  );
  eq([ok, started], [true, true]);
});

check(
  'briefSaveState — «сохранено» гаснет от правки, вернул как было — снова сохранено',
  () => {
    eq(briefSaveState(false, false), null);
    eq(briefSaveState(true, false), 'saved');
    eq(briefSaveState(true, true), 'unsaved');
    eq(briefSaveState(false, true), 'unsaved');
  }
);

console.log(failed ? `\n${failed} провалено` : `\n${passed} проверок пройдено`);
if (failed) process.exit(1);
