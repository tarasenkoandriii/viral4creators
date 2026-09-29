// Plain assertions runnable with `npx tsx scripts/greeting-occasion-fields.test.ts`.
//
// Этап D ТЗ Greeting 2.0 (§3.4 п. 1, §3.5): блок «повод → настроение →
// тон» общий у экрана создания и брифа мастера. Таблица — живая серверная
// (`greetingPolicyView()`), по той же причине, что в greeting-policy.test.ts:
// рукописная копия в тесте разошлась бы с сервером молча.

import * as backendPolicyNs from '../../backend/src/common/greeting-policy';
import {
  applyOccasionPatch,
  createToneField,
  effectiveServerRegister,
  formatToneChange,
  initialMood,
  occasionFieldsComplete,
  occasionRegisterField,
  raisedMoodToShow,
  raisedServerRegister,
  type OccasionFieldsState,
} from '../src/lib/greeting-occasion-fields';

const backend =
  (backendPolicyNs as { default?: typeof backendPolicyNs }).default ??
  backendPolicyNs;
const policy = JSON.parse(JSON.stringify(backend.greetingPolicyView()));

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

const base: OccasionFieldsState = {
  occasion: 'BIRTHDAY',
  customOccasionText: '',
  mood: null,
  tone: 'FUNNY',
};

// ── Настроение из сохранённого брифа ────────────────────────────────────

check('ответ человека подставляется', () => {
  eq(
    initialMood({
      occasion: 'OTHER',
      occasionRegister: 'SOLEMN',
      registerSource: 'user',
    }),
    'SOLEMN'
  );
});

check('поднятый сервером регистр ответом НЕ считается', () => {
  for (const registerSource of ['keywords', 'classifier', 'default', null]) {
    eq(
      initialMood({
        occasion: 'OTHER',
        occasionRegister: 'MOURNING',
        registerSource: registerSource as 'keywords',
      }),
      null
    );
  }
});

check(
  'ответ, сохранённый отдельно, подставляется и при поднятом регистре',
  () => {
    for (const registerSource of ['keywords', 'classifier', 'user']) {
      eq(
        initialMood({
          occasion: 'OTHER',
          occasionRegister: 'MOURNING',
          registerSource: registerSource as 'keywords',
          userOccasionRegister: 'SOLEMN',
        }),
        'SOLEMN'
      );
    }
  }
);

check('старый бриф без поля: ответ — только при источнике user', () => {
  eq(
    initialMood({
      occasion: 'OTHER',
      occasionRegister: 'SOLEMN',
      registerSource: 'user',
      userOccasionRegister: null,
    }),
    'SOLEMN'
  );
  eq(
    initialMood({
      occasion: 'OTHER',
      occasionRegister: 'MOURNING',
      registerSource: 'keywords',
      userOccasionRegister: null,
    }),
    null
  );
});

check('у повода из списка ответа нет', () => {
  eq(
    initialMood({
      occasion: 'BIRTHDAY',
      occasionRegister: 'CELEBRATORY',
      registerSource: 'user',
      userOccasionRegister: 'CELEBRATORY',
    }),
    null
  );
});

check('поднятый регистр виден только от ключевых слов и классификатора', () => {
  eq(
    raisedServerRegister({
      occasion: 'OTHER',
      occasionRegister: 'MOURNING',
      registerSource: 'keywords',
    }),
    'MOURNING'
  );
  eq(
    raisedServerRegister({
      occasion: 'OTHER',
      occasionRegister: 'SENSITIVE',
      registerSource: 'classifier',
    }),
    'SENSITIVE'
  );
  eq(
    raisedServerRegister({
      occasion: 'OTHER',
      occasionRegister: 'SOLEMN',
      registerSource: 'user',
    }),
    null
  );
});

// ── Смена повода и настроения ───────────────────────────────────────────

check('шутливый тон при соболезновании сбрасывается и называется', () => {
  const r = applyOccasionPatch(policy, base, { occasion: 'CONDOLENCE' }, null);
  eq(r.patch, { occasion: 'CONDOLENCE', tone: 'RESPECTFUL' });
  eq(r.change, { from: 'FUNNY', to: 'RESPECTFUL' });
});

check('допустимый тон при смене повода не трогается', () => {
  const r = applyOccasionPatch(
    policy,
    { ...base, tone: 'FORMAL' },
    { occasion: 'CORPORATE' },
    null
  );
  eq(r.patch, { occasion: 'CORPORATE' });
  eq(r.change, null);
});

check('«Особый повод» без ответа тон не трогает — регистра ещё нет', () => {
  const r = applyOccasionPatch(policy, base, { occasion: 'OTHER' }, null);
  eq(r.patch, { occasion: 'OTHER' });
  eq(r.change, null);
});

check('ответ «траурное» сбрасывает шутливый тон', () => {
  const r = applyOccasionPatch(
    policy,
    { ...base, occasion: 'OTHER' },
    { mood: 'MOURNING' },
    null
  );
  eq(r.change?.from, 'FUNNY');
  eq(r.patch.mood, 'MOURNING');
  eq(r.patch.tone, r.change?.to);
});

check('поднятый сервером регистр ограничивает и мягкий ответ', () => {
  // Человек ответил «радостное», а слово «похороны» подняло до траура:
  // шутливый тон всё равно недоступен — сервер регистр не опустит.
  const r = applyOccasionPatch(
    policy,
    { ...base, occasion: 'OTHER' },
    { mood: 'CELEBRATORY' },
    'MOURNING'
  );
  eq(r.change?.from, 'FUNNY');
});

check('без таблицы тон не трогается — решает сервер', () => {
  const r = applyOccasionPatch(null, base, { occasion: 'CONDOLENCE' }, null);
  eq(r.patch, { occasion: 'CONDOLENCE' });
  eq(r.change, null);
});

check('строка изменения тона — на языке словаря', () => {
  const names = {
    WARM: 'тёплый',
    FUNNY: 'с юмором',
    FORMAL: 'официальный',
    SUPPORTIVE: 'поддерживающий',
    RESPECTFUL: 'уважительный',
  };
  eq(
    formatToneChange(
      'Тон: {from} → {to}',
      { from: 'FUNNY', to: 'RESPECTFUL' },
      names
    ),
    'Тон: с юмором → уважительный'
  );
});

// ── Строка «уточнено как …» ─────────────────────────────────────────────

check('строка есть, когда сервер строже ответа', () => {
  eq(raisedMoodToShow(policy, 'OTHER', 'CELEBRATORY', 'MOURNING'), 'MOURNING');
});

check('строки нет, когда ответ не мягче сервера', () => {
  eq(raisedMoodToShow(policy, 'OTHER', 'MOURNING', 'MOURNING'), null);
  eq(raisedMoodToShow(policy, 'OTHER', 'MOURNING', 'SENSITIVE'), null);
});

check('без ответа строка есть — проверка уже решила', () => {
  eq(raisedMoodToShow(policy, 'OTHER', null, 'SENSITIVE'), 'SENSITIVE');
});

check('строки нет, если поднятый регистр не гасит ни одного тона', () => {
  // «Праздничное» → «тёплое нейтральное»: наборы тонов одинаковые, и
  // «часть тонов недоступна» было бы неправдой.
  eq(raisedMoodToShow(policy, 'OTHER', 'CELEBRATORY', 'WARM_NEUTRAL'), null);
});

check('строка есть при равном числе тонов, но другом наборе', () => {
  // У «тёплого» и «торжественного» по три тона, но «С юмором» гаснет.
  eq(raisedMoodToShow(policy, 'OTHER', 'WARM_NEUTRAL', 'SOLEMN'), 'SOLEMN');
});

check('без таблицы строки нет — тоны тогда доступны все', () => {
  eq(raisedMoodToShow(null, 'OTHER', 'CELEBRATORY', 'MOURNING'), null);
});

check('строка «часть тонов недоступна» правдива на всех парах', () => {
  // Строка есть ⇔ хоть один тон, открытый ответом (или любой из пяти без
  // ответа), погашен на экране.
  const tones = ['WARM', 'FUNNY', 'FORMAL', 'SUPPORTIVE', 'RESPECTFUL'];
  const regs = [
    'CELEBRATORY',
    'WARM_NEUTRAL',
    'SOLEMN',
    'SENSITIVE',
    'MOURNING',
  ] as const;
  for (const mood of [null, ...regs]) {
    for (const server of regs) {
      const shown = raisedMoodToShow(policy, 'OTHER', mood, server) !== null;
      const onScreen = backend.tonesFor(
        'OTHER',
        backend.stricterRegister(mood ?? server, server)
      );
      const before = mood ? backend.tonesFor('OTHER', mood) : tones;
      const lost = before.some((t: string) => !onScreen.includes(t as never));
      eq([mood, server, shown], [mood, server, lost]);
    }
  }
});

// ── Поднятый регистр и переписанное описание ────────────────────────────

const raisedBrief = {
  occasion: 'OTHER' as const,
  occasionRegister: 'MOURNING' as const,
  registerSource: 'keywords' as const,
  customOccasionText: 'Поминки дедушки',
};

check('поднятый регистр держит тоны, пока описание то же', () => {
  eq(
    effectiveServerRegister(raisedBrief, {
      occasion: 'OTHER',
      customOccasionText: '  Поминки дедушки ',
    }),
    'MOURNING'
  );
});

check('описание переписано — поднятый регистр больше не держит тоны', () => {
  eq(
    effectiveServerRegister(raisedBrief, {
      occasion: 'OTHER',
      customOccasionText: 'Юбилей дедушки',
    }),
    null
  );
  // …и шутливый тон снова доступен при «радостном» ответе.
  const r = applyOccasionPatch(
    policy,
    {
      ...base,
      occasion: 'OTHER',
      customOccasionText: 'Юбилей дедушки',
      tone: 'FUNNY',
    },
    { mood: 'CELEBRATORY' },
    effectiveServerRegister(raisedBrief, {
      occasion: 'OTHER',
      customOccasionText: 'Юбилей дедушки',
    })
  );
  eq(r.change, null);
});

check('повод сменили с «Особого» — поднятого регистра нет', () => {
  eq(
    effectiveServerRegister(raisedBrief, {
      occasion: 'BIRTHDAY',
      customOccasionText: 'Поминки дедушки',
    }),
    null
  );
});

check('без ответа, но с поднятым регистром шутка сбрасывается', () => {
  // Бриф после перезагрузки: ответа нет, но сервер уже поднял до траура.
  const r = applyOccasionPatch(policy, base, { occasion: 'OTHER' }, 'MOURNING');
  eq(r.change?.from, 'FUNNY');
});

check(
  'переписанное описание снимает подъём — несовместимый тон сбрасывается с отчётом',
  () => {
    // Повторный аудит этапа D: «Поминки» подняли до траура, тон SUPPORTIVE,
    // ответ человека — «радостное». Описание переписано — подъём снят, и
    // SUPPORTIVE радостному поводу недоступен: тон обязан смениться с
    // отчётом, а не остаться серым до отказа сервера.
    const state = {
      occasion: 'OTHER' as const,
      customOccasionText: raisedBrief.customOccasionText ?? '',
      mood: 'CELEBRATORY' as const,
      tone: 'SUPPORTIVE' as const,
    };
    const r = applyOccasionPatch(
      policy,
      state,
      { customOccasionText: 'Юбилей бабушки' },
      (next) => effectiveServerRegister(raisedBrief, next)
    );
    eq(r.change?.from, 'SUPPORTIVE');
    eq(r.patch.tone, 'WARM');
    eq(r.patch.customOccasionText, 'Юбилей бабушки');
    // И обратно: вернули прежний текст — подъём вернулся, шутка гасится.
    const back = applyOccasionPatch(
      policy,
      { ...state, customOccasionText: 'Юбилей бабушки', tone: 'FUNNY' },
      { customOccasionText: raisedBrief.customOccasionText ?? '' },
      (next) => effectiveServerRegister(raisedBrief, next)
    );
    eq(back.change?.from, 'FUNNY');
  }
);

check('уход с «Особого повода» забывает ответ о настроении', () => {
  const r = applyOccasionPatch(
    policy,
    {
      occasion: 'OTHER',
      customOccasionText: 'Юбилей',
      mood: 'SOLEMN',
      tone: 'WARM',
    },
    { occasion: 'BIRTHDAY' },
    null
  );
  eq(r.patch.mood, null);
  // Смена настроения внутри «Особого» ответ, разумеется, не стирает.
  const same = applyOccasionPatch(
    policy,
    {
      occasion: 'OTHER',
      customOccasionText: 'x',
      mood: 'SOLEMN',
      tone: 'WARM',
    },
    { mood: 'SENSITIVE' },
    null
  );
  eq(same.patch.mood, 'SENSITIVE');
});

// ── Тон в запросе создания ──────────────────────────────────────────────

check('таблицы нет, тон не трогали — заглушку не шлём', () => {
  eq(
    createToneField('WARM', { policyLoaded: false, toneTouched: false }),
    undefined
  );
});

check('тон, выбранный человеком, уходит всегда', () => {
  eq(
    createToneField('FUNNY', { policyLoaded: false, toneTouched: true }),
    'FUNNY'
  );
  eq(
    createToneField('RESPECTFUL', { policyLoaded: true, toneTouched: false }),
    'RESPECTFUL'
  );
});

// ── Сохранение ──────────────────────────────────────────────────────────

check('«Особый повод» без ответа о настроении не сохраняется', () => {
  eq(
    occasionFieldsComplete({
      occasion: 'OTHER',
      customOccasionText: 'Проводы бабушки',
      mood: null,
    }),
    false
  );
  eq(
    occasionFieldsComplete({
      occasion: 'OTHER',
      customOccasionText: '  ',
      mood: 'SOLEMN',
    }),
    false
  );
  eq(
    occasionFieldsComplete({
      occasion: 'OTHER',
      customOccasionText: 'Проводы бабушки',
      mood: 'SOLEMN',
    }),
    true
  );
});

check('повод из списка настроения не требует', () => {
  eq(
    occasionFieldsComplete({
      occasion: 'BIRTHDAY',
      customOccasionText: '',
      mood: null,
    }),
    true
  );
});

check('ответ о настроении уходит только у «Особого повода»', () => {
  eq(occasionRegisterField({ occasion: 'OTHER', mood: 'SOLEMN' }), 'SOLEMN');
  // Настроение, оставшееся в состоянии после ухода с «Особого», не
  // уходит: у повода из списка регистр задаёт каталог.
  eq(occasionRegisterField({ occasion: 'BIRTHDAY', mood: 'SOLEMN' }), null);
});

console.log(failed ? `\n${failed} провалено` : `\n${passed} проверок пройдено`);
if (failed) process.exit(1);
