// Plain assertions runnable with `npx tsx scripts/voice-brief.test.ts`.
//
// Этап K3 ТЗ Greeting 2.0 §4А.2 п. 3–4, §4А.7.1: голосом — в поля брифа
// по тем же правилам, что руками. Таблица регистров — живая серверная
// (`greetingPolicyView()`), как в greeting-occasion-fields.test.ts.

import * as backendPolicyNs from '../../backend/src/common/greeting-policy';
import {
  BRIEF_MESSAGE_MAX,
  BRIEF_NAME_MAX,
  BRIEF_VOICE_TARGETS as T,
  BRIEF_VOICE_TARGET_LIST,
  applyBriefVoiceFields,
  isIsoDate,
  toneForCommand,
} from '../src/lib/voice-brief';
import type { OccasionFieldsState } from '../src/lib/greeting-occasion-fields';
import type { VoiceField } from '../src/lib/voice-types';

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

const f = (target: string, value: string | boolean): VoiceField => ({
  target,
  value,
  label: target,
});
const birthdayFunny: OccasionFieldsState = {
  occasion: 'BIRTHDAY',
  customOccasionText: '',
  mood: null,
  tone: 'FUNNY',
};
const noRaise = () => null;

check('одиннадцать хуков — те, что в контракте', () => {
  eq(BRIEF_VOICE_TARGET_LIST.length, 11);
  eq(new Set(BRIEF_VOICE_TARGET_LIST).size, 11);
  for (const t of BRIEF_VOICE_TARGET_LIST) {
    if (!/^greeting-field-[a-z-]+$/.test(t)) throw new Error(t);
  }
});

check(
  'повод «соболезнование» сбрасывает «с юмором» — и называет замену',
  () => {
    const r = applyBriefVoiceFields(
      policy,
      birthdayFunny,
      [f(T.occasion, 'CONDOLENCE')],
      noRaise
    );
    eq(r.occPatch, { occasion: 'CONDOLENCE', tone: 'RESPECTFUL' });
    eq(r.toneChange, { from: 'FUNNY', to: 'RESPECTFUL' });
    eq(r.refused, []);
  }
);

check('порядок человека, а не порядок в ответе: повод, потом тон', () => {
  // Тон пришёл РАНЬШЕ повода — применённый первым, он был бы стёрт
  // сбросом по новому регистру.
  const r = applyBriefVoiceFields(
    policy,
    birthdayFunny,
    [f(T.tone, 'SUPPORTIVE'), f(T.occasion, 'CONDOLENCE')],
    noRaise
  );
  eq(r.occPatch, { occasion: 'CONDOLENCE', tone: 'SUPPORTIVE' });
  // Тон выбран человеком — строки «Тон: … → …» нет, как после пилюли.
  eq(r.toneChange, null);
});

check(
  'тон, погашенный регистром, не применяется — отказ причиной экрана',
  () => {
    const condolence: OccasionFieldsState = {
      ...birthdayFunny,
      occasion: 'CONDOLENCE',
      tone: 'RESPECTFUL',
    };
    const r = applyBriefVoiceFields(
      policy,
      condolence,
      [f(T.tone, 'FUNNY')],
      noRaise
    );
    eq(r.occPatch, null);
    eq(r.refused, [{ target: T.tone, reason: 'tone-unavailable' }]);
  }
);

check('без таблицы (не загрузилась) тон не гасится — решает сервер', () => {
  const r = applyBriefVoiceFields(
    null,
    { ...birthdayFunny, occasion: 'CONDOLENCE' },
    [f(T.tone, 'FUNNY')],
    noRaise
  );
  eq(r.refused, []);
});

check('описание и настроение — только у «Особого повода»', () => {
  const r = applyBriefVoiceFields(
    policy,
    birthdayFunny,
    [f(T.customOccasion, 'поминки'), f(T.mood, 'MOURNING')],
    noRaise
  );
  eq(r.refused, [
    { target: T.customOccasion, reason: 'not-other' },
    { target: T.mood, reason: 'not-other' },
  ]);
  eq(r.occPatch, null);
});

check(
  '«Особый повод, поминки, траурное» — одной карточкой, тон по регистру',
  () => {
    const r = applyBriefVoiceFields(
      policy,
      birthdayFunny,
      [
        f(T.mood, 'MOURNING'),
        f(T.customOccasion, 'поминки'),
        f(T.occasion, 'OTHER'),
      ],
      noRaise
    );
    eq(r.occPatch, {
      occasion: 'OTHER',
      customOccasionText: 'поминки',
      mood: 'MOURNING',
      tone: 'RESPECTFUL',
    });
    eq(r.toneChange, { from: 'FUNNY', to: 'RESPECTFUL' });
  }
);

check('поднятый сервером регистр учитывается и голосом', () => {
  const other: OccasionFieldsState = {
    occasion: 'OTHER',
    customOccasionText: 'поминки',
    mood: 'CELEBRATORY',
    tone: 'WARM',
  };
  const r = applyBriefVoiceFields(
    policy,
    other,
    [f(T.tone, 'FUNNY')],
    () => 'MOURNING'
  );
  eq(r.refused, [{ target: T.tone, reason: 'tone-unavailable' }]);
});

check('списки — только коды вариантов', () => {
  const r = applyBriefVoiceFields(
    policy,
    birthdayFunny,
    [
      f(T.occasion, 'Birthday'),
      f(T.scriptLanguage, 'uk'),
      f(T.presenter, 'veo'),
      f(T.resolution, '1080p'),
      f(T.tone, 'SERIOUS'),
      f(T.mood, true),
    ],
    noRaise
  );
  eq(r.patch, { scriptLanguage: 'uk', resolution: '1080p' });
  eq(
    r.refused.map((x) => x.target),
    [T.occasion, T.mood, T.tone, T.presenter]
  );
});

check(
  'тексты — тем же потолком, что ручной ввод; имя получателя не пустое',
  () => {
    const long = 'я'.repeat(5000);
    const r = applyBriefVoiceFields(
      policy,
      birthdayFunny,
      [f(T.recipient, long), f(T.sender, long), f(T.message, long)],
      noRaise
    );
    eq(r.patch.recipientName?.length, BRIEF_NAME_MAX);
    eq(r.patch.senderName?.length, BRIEF_NAME_MAX);
    eq(r.patch.personalMessage?.length, BRIEF_MESSAGE_MAX);
    const empty = applyBriefVoiceFields(
      policy,
      birthdayFunny,
      [f(T.recipient, '  ')],
      noRaise
    );
    eq(empty.refused, [{ target: T.recipient, reason: 'invalid' }]);
    eq(empty.patch, {});
    // Отправитель необязателен: «без подписи» — законное значение.
    eq(
      applyBriefVoiceFields(policy, birthdayFunny, [f(T.sender, '')], noRaise)
        .patch,
      {
        senderName: '',
      }
    );
  }
);

check('дата — только настоящий ISO', () => {
  eq(isIsoDate('2026-10-05'), true);
  eq(isIsoDate('2026-02-30'), false);
  eq(isIsoDate('05.10.2026'), false);
  const r = applyBriefVoiceFields(
    policy,
    birthdayFunny,
    [f(T.date, '2026-10-05')],
    noRaise
  );
  eq(r.patch, { occasionDate: '2026-10-05' });
  eq(
    applyBriefVoiceFields(policy, birthdayFunny, [f(T.date, 'завтра')], noRaise)
      .refused,
    [{ target: T.date, reason: 'invalid' }]
  );
});

// ── Команды тона ───────────────────────────────────────────────────────

check('«серьёзнее» — на ступень к ближайшему допустимому', () => {
  eq(
    toneForCommand('tone-serious', 'FUNNY', policy, 'BIRTHDAY', 'CELEBRATORY'),
    { tone: 'WARM' }
  );
  // У дня рождения нет «поддерживающего» — шаг через него к официальному.
  eq(
    toneForCommand('tone-serious', 'WARM', policy, 'BIRTHDAY', 'CELEBRATORY'),
    { tone: 'FORMAL' }
  );
});

check('«легче» на соболезновании — отказ «недоступно», а не молчание', () => {
  eq(
    toneForCommand(
      'tone-lighter',
      'SUPPORTIVE',
      policy,
      'CONDOLENCE',
      'MOURNING'
    ),
    { refusal: 'unavailable' }
  );
  eq(
    toneForCommand(
      'tone-lighter',
      'RESPECTFUL',
      policy,
      'CONDOLENCE',
      'MOURNING'
    ),
    { tone: 'SUPPORTIVE' }
  );
});

check('край шкалы — «уже»', () => {
  eq(
    toneForCommand(
      'tone-serious',
      'RESPECTFUL',
      policy,
      'CONDOLENCE',
      'MOURNING'
    ),
    {
      refusal: 'already',
    }
  );
  eq(
    toneForCommand('tone-lighter', 'FUNNY', policy, 'BIRTHDAY', 'CELEBRATORY'),
    {
      refusal: 'already',
    }
  );
});

check('«без шуток»: у шуточного — серьёзнее, у остальных — «и так нет»', () => {
  eq(toneForCommand('no-jokes', 'FUNNY', policy, 'BIRTHDAY', 'CELEBRATORY'), {
    tone: 'WARM',
  });
  eq(toneForCommand('no-jokes', 'FORMAL', policy, 'BIRTHDAY', 'CELEBRATORY'), {
    refusal: 'already',
  });
});

check('тон из args сервера важнее своей шкалы', () => {
  // Своя шкала от «тёплого» дала бы «официальный»; сервер назвал другой.
  eq(
    toneForCommand(
      'tone-serious',
      'WARM',
      policy,
      'OTHER',
      'SOLEMN',
      'RESPECTFUL'
    ),
    { tone: 'RESPECTFUL' }
  );
  eq(
    toneForCommand(
      'tone-lighter',
      'FORMAL',
      policy,
      'BIRTHDAY',
      'CELEBRATORY',
      'WARM'
    ),
    { tone: 'WARM' }
  );
});

check(
  'args.tone проверяется экраном: погашенный — отказ, тот же — «уже»',
  () => {
    // Бриф изменился после разбора: теперь соболезнование, «с юмором» погашен.
    eq(
      toneForCommand(
        'tone-lighter',
        'RESPECTFUL',
        policy,
        'CONDOLENCE',
        'MOURNING',
        'FUNNY'
      ),
      { refusal: 'unavailable' }
    );
    eq(
      toneForCommand(
        'tone-serious',
        'FORMAL',
        policy,
        'BIRTHDAY',
        'CELEBRATORY',
        'FORMAL'
      ),
      { refusal: 'already' }
    );
  }
);

check('args.tone не из списка — запасная шкала', () => {
  eq(
    toneForCommand(
      'tone-serious',
      'FUNNY',
      policy,
      'BIRTHDAY',
      'CELEBRATORY',
      'SERIOUS'
    ),
    { tone: 'WARM' }
  );
});

console.log(failed ? `\n${failed} провалено` : `\n${passed} проверок пройдено`);
if (failed) process.exit(1);
