// Plain assertions runnable with `npx tsx scripts/greeting-character.test.ts`.
//
// Этап D ТЗ Greeting 2.0 (§3.3, §3.5): сводка блока «Характер ролика» и
// предупреждение о своей музыке у деликатного и траурного регистров.

import {
  cardsSummary,
  characterRegister,
  characterSummaryLine,
  musicSummary,
  scenesSummary,
  showOwnMusicWarning,
  stickerCardHidden,
  stickerSummary,
  voiceSummary,
  characterLockOf,
  lockedFieldRefusals,
  senderVoiceKind,
} from '../src/lib/greeting-character';
import type { GreetingPolicyView } from '../src/lib/greeting-policy';

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

const w = {
  summaryVoice: 'Голос',
  summaryMusic: 'Музыка',
  summaryCards: 'Надписи',
  summarySticker: 'Наклейка',
  summaryScenes: 'Сцены',
  summaryNone: 'нет',
  summaryDefault: 'по умолчанию',
  summaryYes: 'есть',
};

const rule = (register: string, ownMusicWarning: boolean) => ({
  register,
  festive: false,
  stickers: false,
  maxScenes: 1,
  catalogUniversalThemes: false,
  ownMusicWarning,
  otherTones: [],
});
const policy = {
  registers: [
    rule('CELEBRATORY', false),
    rule('WARM_NEUTRAL', false),
    rule('SOLEMN', false),
    rule('SENSITIVE', true),
    rule('MOURNING', true),
  ],
  occasions: [
    { occasion: 'BIRTHDAY', register: 'CELEBRATORY', tones: [] },
    { occasion: 'CONDOLENCE', register: 'MOURNING', tones: [] },
  ],
} as unknown as GreetingPolicyView;

check('голос: клон отправителя, затем пресет, затем умолчание', () => {
  eq(voiceSummary({ senderLabel: 'Мама', presetName: 'Eve' }, w), 'Мама');
  eq(voiceSummary({ senderLabel: null, presetName: 'Eve' }, w), 'Eve');
  eq(voiceSummary({ senderLabel: null, presetName: null }, w), 'по умолчанию');
});

// S2: голос Soniox — третий вид; «по умолчанию» у Soniox — не то же, что
// «голос по умолчанию» стенда, и сводка их различает.
const s2 = {
  summaryDefault: 'Soniox по умолчанию',
  summaryNamed: 'Soniox · {label}',
};
check(
  'голос Soniox: имя каталога, id без имени, голос Soniox по умолчанию',
  () => {
    const v = (
      soniox: { voiceId: string | null; label: string | null } | null
    ) => voiceSummary({ senderLabel: null, presetName: null, soniox }, w, s2);
    eq(
      v({ voiceId: 'Maya', label: 'Maya (female)' }),
      'Soniox · Maya (female)'
    );
    eq(v({ voiceId: 'Adrian', label: null }), 'Soniox · Adrian');
    eq(v({ voiceId: null, label: null }), 'Soniox по умолчанию');
    // Soniox не выбран — прежнее «по умолчанию» стенда.
    eq(v(null), 'по умолчанию');
    // Без подписей Soniox (старый вызывающий) — прежнее поведение.
    eq(
      voiceSummary(
        {
          senderLabel: null,
          presetName: null,
          soniox: { voiceId: 'x', label: 'X' },
        },
        w
      ),
      'по умолчанию'
    );
  }
);

check('голос: порядок видов у сводки и у кнопки «Снять» один', () => {
  const both = { voiceId: 'Maya', label: 'Maya' };
  eq(
    voiceSummary(
      { senderLabel: 'Мама', presetName: null, soniox: both },
      w,
      s2
    ),
    'Мама'
  );
  eq(
    voiceSummary({ senderLabel: null, presetName: 'Eve', soniox: both }, w, s2),
    'Eve'
  );
  eq(
    senderVoiceKind({
      senderVoice: { label: 'Мама' },
      presetVoiceId: 'eve',
      sonioxVoice: both,
    }),
    'clone'
  );
  eq(
    senderVoiceKind({
      senderVoice: null,
      presetVoiceId: 'eve',
      sonioxVoice: both,
    }),
    'preset'
  );
  eq(
    senderVoiceKind({
      senderVoice: null,
      presetVoiceId: null,
      sonioxVoice: both,
    }),
    'soniox'
  );
  // «Голос Soniox по умолчанию» — тоже выбран: снимать есть что.
  eq(
    senderVoiceKind({
      senderVoice: null,
      presetVoiceId: null,
      sonioxVoice: { voiceId: null, label: null },
    }),
    'soniox'
  );
  eq(
    senderVoiceKind({
      senderVoice: null,
      presetVoiceId: null,
      sonioxVoice: null,
    }),
    'default'
  );
  // Сервер до S2 поля не отдавал.
  eq(senderVoiceKind({ senderVoice: null, presetVoiceId: null }), 'default');
});

// Аудит этапа D: «Голос: по умолчанию» до ответа и после ошибки, «Музыка:
// нет» после ошибки — сводка утверждала то, чего мы не прочитали.
check('не прочитано — части нет в сводке, а не «по умолчанию»/«нет»', () => {
  eq(voiceSummary(null, w), null);
  eq(musicSummary(null, w), null);
  eq(cardsSummary(null, w), null);
  eq(stickerSummary(null, w), null);
  eq(scenesSummary(null), null);
});

check('музыка: название выбранной темы или «нет»', () => {
  eq(musicSummary({ selected: { title: 'Вальс' } }, w), 'Вальс');
  eq(musicSummary({ selected: null }, w), 'нет');
});

check('титры: считаются только непустые сохранённые', () => {
  eq(cardsSummary({ title: 'С днём!', closing: 'Люблю' }, w), '2');
  eq(cardsSummary({ title: '  ', closing: 'Люблю' }, w), '1');
  eq(cardsSummary({ title: null, closing: null }, w), 'нет');
});

check('наклейка: есть / нет, скрытая карточка — вне сводки', () => {
  const on = { configured: true, allowed: true };
  eq(stickerSummary({ ...on, selected: { url: 'x' } }, w), 'есть');
  eq(stickerSummary({ ...on, selected: null }, w), 'нет');
  // Без ключа Pixabay и без выбора карточки нет — и в сводке тоже.
  eq(stickerCardHidden({ configured: false, selected: null }), true);
  eq(stickerSummary({ configured: false, selected: null }, w), null);
  // Без ключа, но выбранная раньше — карточка есть, её можно снять.
  eq(stickerCardHidden({ configured: false, selected: { url: 'x' } }), false);
  eq(stickerSummary({ configured: false, selected: { url: 'x' } }, w), 'есть');
  eq(stickerCardHidden(null), true);
});

check('наклейка не разрешена поводу и не выбрана — «нет»', () => {
  // Карточка на экране и объясняет почему; «нет» — правда о ролике.
  eq(
    stickerSummary({ configured: true, allowed: false, selected: null }, w),
    'нет'
  );
});

check('сцены', () => {
  eq(scenesSummary({ sceneCount: 3 }), '3');
});

check('строка сводки — в порядке карточек, без скрытых частей', () => {
  eq(
    characterSummaryLine(
      { scenes: '2', voice: 'Мама', music: 'нет', sticker: null },
      w
    ),
    'Голос: Мама · Музыка: нет · Сцены: 2'
  );
  eq(characterSummaryLine({}, w), '');
});

check('регистр: каталожный повод — по таблице', () => {
  eq(characterRegister(policy, { occasion: 'CONDOLENCE' }), 'MOURNING');
  // Серверный итог «Особого повода» у каталожного повода не участвует.
  eq(
    characterRegister(policy, {
      occasion: 'BIRTHDAY',
      occasionRegister: 'MOURNING',
    }),
    'CELEBRATORY'
  );
});

check('регистр: «Особый повод» — итог сервера или WARM_NEUTRAL', () => {
  eq(
    characterRegister(policy, {
      occasion: 'OTHER',
      occasionRegister: 'SENSITIVE',
    }),
    'SENSITIVE'
  );
  eq(
    characterRegister(policy, { occasion: 'OTHER', occasionRegister: null }),
    'WARM_NEUTRAL'
  );
});

check('регистр: нет таблицы — не знаем', () => {
  eq(characterRegister(null, { occasion: 'CONDOLENCE' }), null);
  // И у «Особого повода» тоже: итог сервера без таблицы правил не даёт.
  eq(
    characterRegister(null, {
      occasion: 'OTHER',
      occasionRegister: 'SENSITIVE',
    }),
    null
  );
});

check('своя музыка: предупреждение только там, где его требует таблица', () => {
  const warn = { ownMusicWarning: true };
  const quiet = { ownMusicWarning: false };
  eq(showOwnMusicWarning(warn, { adding: true, selected: null }), true);
  eq(
    showOwnMusicWarning(warn, {
      adding: false,
      selected: { source: 'upload' },
    }),
    true
  );
  eq(
    showOwnMusicWarning(warn, {
      adding: false,
      selected: { source: 'library' },
    }),
    true
  );
  eq(
    showOwnMusicWarning(warn, {
      adding: false,
      selected: { source: 'catalog' },
    }),
    false
  );
  // Старая запись без source — каталожная.
  eq(showOwnMusicWarning(warn, { adding: false, selected: {} }), false);
  eq(showOwnMusicWarning(warn, { adding: false, selected: null }), false);
  eq(showOwnMusicWarning(quiet, { adding: true, selected: null }), false);
  eq(showOwnMusicWarning(null, { adding: true, selected: null }), false);
});

check('замок карточек: готов — done, снимается — busy, иначе открыто', () => {
  eq(characterLockOf('complete'), 'done');
  eq(characterLockOf('pending'), 'busy');
  eq(characterLockOf('processing'), 'busy');
  // Упавший рендер — карточки открыты: «Повторить» снимет с правками.
  eq(characterLockOf('failed'), null);
  eq(characterLockOf(undefined), null);
  eq(characterLockOf(null), null);
});

check('голос в запертых карточках — отказ по строке на каждое поле', () => {
  eq(
    lockedFieldRefusals(
      [
        { target: 'greeting-music-theme', label: 'Музыка' },
        { target: 'greeting-scenes-count', label: '' },
      ],
      'Не применил «{field}»: {reason}.',
      'Ролик готов. Поправьте бриф.'
    ),
    [
      'Не применил «Музыка»: Ролик готов. Поправьте бриф.',
      'Не применил «greeting-scenes-count»: Ролик готов. Поправьте бриф.',
    ]
  );
  eq(lockedFieldRefusals([], 'x', 'y'), []);
});

console.log(failed ? `\n${failed} провалено` : `\n${passed} проверок пройдено`);
if (failed) process.exit(1);
