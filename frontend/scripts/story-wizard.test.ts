import assert from 'node:assert/strict';
import {
  budgetWarning,
  buildPreviewPayload,
  buildStoryPayload,
  canCreate,
  draftParts,
  estimateRows,
  formatUsd,
  occasionCaption,
  previewKey,
  themeFor,
  wizardIssues,
  type StoryEstimate,
  type WizardState,
} from '../src/features/stories/story-wizard';

const base: WizardState = {
  catalogId: 'turnip-ushinsky-ru-1949-v1',
  budget: '1',
  country: 'UA',
  occasionKind: null,
  occasionLabel: '',
  theme: null,
  giftNoteEnabled: false,
  giftNote: '',
  giftNotePosition: 'end',
  photoDescription: '',
  includeVideo: false,
};

// Повод можно пропустить: в теле нет ни пресета, ни подписи, тема спокойная.
assert.deepEqual(buildStoryPayload(base), {
  catalogId: base.catalogId,
  budgetUsd: 1,
  countryCode: 'UA',
  giftNoteEnabled: false,
  giftNotePosition: 'end',
});
assert.equal(themeFor(null), 'calm');
assert.equal(themeFor('birthday'), 'celebration');
assert.equal(themeFor('bedtime', 'warm'), 'warm');
assert.equal(themeFor('bedtime', 'neon'), 'night');

// Подпись уходит только для «другого» повода; пресет подписи не несёт.
assert.equal(
  buildStoryPayload({ ...base, occasionKind: 'birthday', occasionLabel: 'x' })
    .occasion,
  undefined
);
assert.equal(
  buildStoryPayload({
    ...base,
    occasionKind: 'other',
    occasionLabel: '  Юбилей   бабушки ',
  }).occasion,
  'Юбилей бабушки'
);
assert.equal(occasionCaption({ occasionKind: 'bedtime' }), 'Перед сном');
assert.equal(
  occasionCaption({ occasionKind: null, occasion: 'Старый повод' }),
  'Старый повод'
);
assert.equal(occasionCaption({ occasionKind: null, occasion: null }), null);

// Реплика уходит только при явном включении; текст без лишних пробелов.
const withNote: WizardState = {
  ...base,
  giftNoteEnabled: true,
  giftNote: ' Загляни  под\nподушку. ',
  giftNotePosition: 'beginning',
};
assert.deepEqual(
  [
    buildStoryPayload(withNote).giftNoteEnabled,
    buildStoryPayload(withNote).giftNote,
  ],
  [true, 'Загляни под подушку.']
);
assert.equal(
  buildStoryPayload({ ...withNote, giftNoteEnabled: false }).giftNote,
  undefined
);
assert.deepEqual(wizardIssues({ ...base, giftNoteEnabled: true }), [
  'Введите реплику о подарке или выключите упоминание',
]);
assert.deepEqual(wizardIssues({ ...base, budget: '0.5' }), [
  'Бюджет — от $1 до $1000',
]);
assert.deepEqual(wizardIssues({ ...base, budget: '2.555' }), [
  'Бюджет — не больше двух знаков после запятой (центы)',
]);
assert.equal(buildStoryPayload({ ...base, budget: '2,5' }).budgetUsd, 2.5);
assert.equal(
  wizardIssues({ ...base, photoDescription: 'x'.repeat(201) }).length,
  1
);

// Создание с репликой — только после свежего предпросмотра точной реплики.
assert.equal(canCreate(withNote, null).ok, false);
const key = previewKey(withNote);
assert.equal(canCreate(withNote, key).ok, true);
assert.equal(
  canCreate({ ...withNote, giftNotePosition: 'end' }, key).ok,
  false,
  'смена позиции требует нового предпросмотра'
);
assert.equal(
  canCreate(base, null).ok,
  true,
  'без реплики предпросмотр необязателен'
);
assert.equal(
  buildPreviewPayload({ ...base, includeVideo: true }).includeVideo,
  true
);

// Смета: строки, прочерк для невключённого, предупреждение при превышении.
const estimate: StoryEstimate = {
  lines: [
    {
      id: 'voice',
      label: 'Голос (Resemble TTS)',
      status: 'included',
      costMicroUsd: 12_000,
      reserveMicroUsd: 48_000,
      items: [
        {
          id: 'voice.main',
          label: 'Основная озвучка',
          characters: 300,
          seconds: 21.4,
          costMicroUsd: 10_000,
        },
      ],
      note: 'Резерв ×4',
    },
    {
      id: 'animation',
      label: 'Анимация преамбулы',
      status: 'unavailable',
      costMicroUsd: 0,
      reserveMicroUsd: 0,
      items: [],
      note: 'Видеоанимации нет',
    },
  ],
  totalCostMicroUsd: 12_000,
  totalReserveMicroUsd: 1_250_000,
  audioReserveMicroUsd: 68_000,
  videoReserveMicroUsd: 1_182_000,
  budgetMicroUsd: 1_000_000,
  remainingMicroUsd: 0,
  overByMicroUsd: 250_000,
  withinBudget: false,
  policy: '…',
};
const rows = estimateRows(estimate);
assert.equal(rows[0].cost, '$0.01');
assert.equal(rows[0].reserve, '$0.05');
assert.ok(/300 симв\. · ≈21 с/.test(rows[0].detail), rows[0].detail);
assert.deepEqual(
  [rows[1].cost, rows[1].status, rows[1].muted],
  ['—', 'недоступно', true]
);
assert.ok(
  /превышает бюджет \$1\.00 на \$0\.25/.test(budgetWarning(estimate) ?? ''),
  String(budgetWarning(estimate))
);
assert.equal(budgetWarning({ ...estimate, withinBudget: true }), null);
assert.equal(formatUsd(0), '$0');
assert.equal(formatUsd(4200), '$0.0042');

// Черновик показывает точный порядок озвучки с выделенной репликой.
const gift = {
  title: 'Репка',
  chapters: [{ text: 'Посадил дед репку.' }],
  giftNote: 'Подарок рядом.',
  giftNotePosition: 'beginning',
};
assert.deepEqual(
  draftParts(gift).map((p) => p.kind),
  ['giftNote', 'main']
);
assert.equal(draftParts(gift)[1].text, 'Репка.\n\nПосадил дед репку.');
assert.deepEqual(
  draftParts({ ...gift, giftNote: null }).map((p) => p.kind),
  ['main']
);

console.log('story-wizard: ok');
