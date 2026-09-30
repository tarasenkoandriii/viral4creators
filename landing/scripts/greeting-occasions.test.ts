/**
 * Группы поводов на странице поздравлений ↔ каталог и политика бэкенда
 * (этап H ТЗ `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §5.2 п.4,
 * §8.4 «Коды и регистры поводов на лендинге совпадают с каталогом»).
 *
 * Лендинг держит КОПИЮ регистров (`src/lib/greeting-occasions.ts`) — импорт
 * из соседнего пакета невозможен. Копия, которую ничто не сверяет,
 * отстаёт молча, а здесь это значит обещание не того: подпись группы
 * «шутливого тона нет» над поводом, где сервер его разрешает, или
 * наоборот. Поэтому сверяется не только копия с каталогом, но и сами
 * ОБЕЩАНИЯ подписей групп — с таблицей `REGISTER_POLICY` и тонами
 * каталога.
 *
 * Бэкенд читается текстом, а не импортом: тот же приём, что у шва в
 * `scripts/check-docs.mjs` и у `greeting-occasions.spec.ts` бэкенда,
 * который так же читает словари лендинга.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getDictionary } from '../src/lib/get-dictionary';
import { locales } from '../src/lib/i18n';
import {
  GREETING_OCCASION_GROUP_ORDER,
  GREETING_OCCASION_REGISTER,
  GROUP_OF_REGISTER,
  OPEN_OCCASION,
  greetingOccasionGroups,
  type GreetingOccasionCode,
} from '../src/lib/greeting-occasions';

const REPO = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// ── Каталог бэкенда: код → { register, tones } ─────────────────────────
const catalogSrc = read('backend/src/common/greeting-occasions.ts');
const specsBody =
  /export const GREETING_OCCASION_SPECS[\s\S]*?> = \{([\s\S]*?)\n\};/.exec(
    catalogSrc,
  )?.[1];
assert.ok(
  specsBody,
  'не нашёлся GREETING_OCCASION_SPECS в каталоге бэкенда — поправьте регулярку теста, а не код',
);
const catalog = new Map<string, { register: string; tones: string }>();
for (const m of specsBody.matchAll(/^ {2}([A-Z_]+): \{([\s\S]*?)^ {2}\},/gm)) {
  const register = /register: '([A-Z_]+)'/.exec(m[2])?.[1];
  const tones = /tones: ([^\n]+),/.exec(m[2])?.[1];
  assert.ok(
    register && tones,
    `каталог: у ${m[1]} не разобрались register/tones`,
  );
  catalog.set(m[1], { register, tones });
}
assert.ok(
  catalog.size >= 24,
  `каталог разобран не целиком: ${catalog.size} поводов`,
);

const copy = GREETING_OCCASION_REGISTER as Record<string, string>;
assert.deepEqual(
  Object.keys(copy).sort(),
  [...catalog.keys()].sort(),
  'набор поводов на лендинге разошёлся с каталогом бэкенда',
);
for (const [code, spec] of catalog) {
  assert.equal(
    copy[code],
    spec.register,
    `${code}: на лендинге регистр ${copy[code]}, в каталоге ${spec.register}`,
  );
}

// ── Регистры: тот же набор и порядок строгости ─────────────────────────
const registersSrc =
  /GREETING_REGISTERS: readonly GreetingRegister\[\] = \[([^\]]*)\]/.exec(
    read('backend/src/common/types/greeting.types.ts'),
  )?.[1];
assert.ok(
  registersSrc,
  'не нашёлся GREETING_REGISTERS — поправьте регулярку теста',
);
const backendRegisters = [...registersSrc.matchAll(/'([A-Z_]+)'/g)].map(
  (m) => m[1],
);
assert.deepEqual(
  Object.keys(GROUP_OF_REGISTER),
  backendRegisters,
  'регистры лендинга (GROUP_OF_REGISTER) разошлись с GREETING_REGISTERS бэкенда',
);

// ── Обещания групп ↔ REGISTER_POLICY ───────────────────────────────────
// Граница групп проведена по двум полям политики (см. lib): праздник —
// `festive`, деликатные — `strictText`. Если политика регистра поменяется,
// подпись группы станет неправдой — и это должно покраснеть здесь.
const policyBody =
  /export const REGISTER_POLICY[\s\S]*?= \{([\s\S]*?)\n\};/.exec(
    read('backend/src/common/greeting-policy.ts'),
  )?.[1];
assert.ok(policyBody, 'не нашёлся REGISTER_POLICY — поправьте регулярку теста');
for (const register of backendRegisters) {
  const block: string | undefined = new RegExp(
    `^ {2}${register}: \\{([\\s\\S]*?)^ {2}\\},`,
    'm',
  ).exec(policyBody)?.[1];
  assert.ok(block, `REGISTER_POLICY: нет блока ${register}`);
  const body: string = block;
  const flag = (name: string): boolean => {
    const v: string | undefined = new RegExp(`${name}: (true|false)`).exec(
      body,
    )?.[1];
    assert.ok(v, `REGISTER_POLICY.${register}: не разобрался ${name}`);
    return v === 'true';
  };
  const expected: string = flag('festive')
    ? 'festive'
    : flag('strictText')
      ? 'delicate'
      : 'calm';
  assert.equal(
    GROUP_OF_REGISTER[register as keyof typeof GROUP_OF_REGISTER],
    expected,
    `${register}: по политике это группа «${expected}», а лендинг кладёт его в «${
      GROUP_OF_REGISTER[register as keyof typeof GROUP_OF_REGISTER]
    }»`,
  );
  // «Деликатные»: подпись обещает, что наклеек и праздничной музыки
  // каталога нет.
  if (expected === 'delicate') {
    assert.equal(
      flag('stickers'),
      false,
      `${register}: подпись обещает «без наклеек»`,
    );
    assert.equal(
      flag('catalogUniversalThemes'),
      false,
      `${register}: подпись обещает «без праздничной музыки каталога»`,
    );
  }
  // «Без праздника»: подпись обещает кадр без праздничных декораций.
  if (expected === 'calm') {
    assert.equal(flag('festive'), false);
  }
}

// ── Тоны: «Праздники» — все три, «Деликатные» — без шуток ──────────────
const groups = greetingOccasionGroups();
for (const group of groups) {
  for (const code of group.codes) {
    const tones = catalog.get(code)!.tones;
    const hasAllThree =
      tones === 'EVERYDAY_TONES' ||
      ['WARM', 'FUNNY', 'FORMAL'].every((t) => tones.includes(`'${t}'`));
    if (group.id === 'festive') {
      assert.ok(
        hasAllThree,
        `${code}: подпись «Праздников» обещает три тона, в каталоге ${tones}`,
      );
    }
    if (group.id === 'delicate') {
      assert.ok(
        tones !== 'EVERYDAY_TONES' && !tones.includes("'FUNNY'"),
        `${code}: подпись «Деликатных» обещает «без шутливого тона», в каталоге ${tones}`,
      );
    }
  }
}

// ── Раскладка: каждый повод ровно в одном месте ────────────────────────
const placed = groups.flatMap((g) => g.codes);
assert.equal(new Set(placed).size, placed.length, 'повод попал в две группы');
assert.ok(
  !placed.includes(OPEN_OCCASION),
  '«Особый повод» не должен стоять в группе',
);
assert.deepEqual(
  [...placed, OPEN_OCCASION].sort(),
  Object.keys(copy).sort(),
  'не все поводы каталога показаны на странице',
);
assert.deepEqual(
  groups.map((g) => g.id),
  [...GREETING_OCCASION_GROUP_ORDER],
);
for (const g of groups) assert.ok(g.codes.length > 0, `группа ${g.id} пуста`);

// ── Словари: подписи групп и плиток во всех локалях ────────────────────
for (const locale of locales) {
  const dict = getDictionary(locale);
  const occ = dict.greetingsLanding.occasions;
  assert.deepEqual(
    Object.keys(occ.groups).sort(),
    [...GREETING_OCCASION_GROUP_ORDER].sort(),
    `${locale}: группы в словаре не совпадают с группами lib`,
  );
  for (const id of GREETING_OCCASION_GROUP_ORDER) {
    assert.ok(
      occ.groups[id].title.trim(),
      `${locale}: пустой заголовок группы ${id}`,
    );
    assert.ok(
      occ.groups[id].text.trim(),
      `${locale}: пустая подпись группы ${id}`,
    );
  }
  assert.ok(
    occ.other.title.trim() && occ.other.text.trim(),
    `${locale}: пустой «свой повод»`,
  );
  // Подписи плиток — из `sharedVideo.occasion`; набор тот же, что в lib.
  assert.deepEqual(
    Object.keys(dict.sharedVideo.occasion).sort(),
    Object.keys(copy).sort(),
    `${locale}: подписи поводов разошлись с набором поводов`,
  );
  for (const code of Object.keys(copy) as GreetingOccasionCode[]) {
    assert.ok(
      dict.sharedVideo.occasion[code].trim(),
      `${locale}: нет подписи ${code}`,
    );
  }
}

console.log(
  `greeting-occasions: ok (${catalog.size} поводов = каталог; ` +
    groups.map((g) => `${g.id} ${g.codes.length}`).join(', ') +
    `; ${OPEN_OCCASION} отдельно)`,
);
