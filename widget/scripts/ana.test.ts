/**
 * Э3-бис: связанный режим — чистые части чанка ana.js и протокол `ana`
 * (ТЗ §5-тер.9, §5-тер.2), паритет назначения группы с сервером, линтер
 * К-11 чанка bf.js (§5-тер.16 п.12).
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  armOf,
  doNotTrack,
  fnv1a32,
  gcmAnalytics,
  parseAna,
  shiftOf,
} from '../src/shared/ana';
import { envelope, parseParentMessage } from '../src/shared/protocol';

// 1. Разбор поля analytics: строго; мусор — без эксперимента/режима.
assert.equal(parseAna(null), null);
assert.equal(parseAna({ behavior: true }), null, 'без consent — режима нет');
const ok = parseAna({
  consent: { gcm: true },
  behavior: true,
  experiment: {
    id: 'exp1',
    kind: 'greeting',
    share: 0.5,
    salt: 'abc',
    variant: { uk: 'Вітаю!', de: 'Hallo', ru: 'x'.repeat(301) },
  },
});
assert.deepEqual(ok, {
  gcm: true,
  behavior: true,
  exp: {
    id: 'exp1',
    kind: 'greeting',
    share: 0.5,
    salt: 'abc',
    greeting: { uk: 'Вітаю!' },
    suggestions: null,
  },
});
assert.equal(
  parseAna({
    consent: {},
    experiment: { id: 'e', kind: 'x', share: 0.5, salt: 's' },
  })!.exp,
  null
);
assert.equal(
  parseAna({
    consent: {},
    experiment: { id: 'e', kind: 'holdout', share: 1, salt: 's' },
  })!.exp,
  null,
  'доля 1 — не эксперимент'
);

// 2. FNV-1a и группа — те же, что у сервера (сервер не верит клиенту, но
//    кнопку прячет загрузчик — расхождение = испорченный эксперимент).
assert.equal(fnv1a32(''), 0x811c9dc5);
assert.equal(fnv1a32('a'), 0xe40c292c);
assert.equal(fnv1a32('foobar'), 0xbf9cf968);
const server = (await import(
  new URL(
    '../../sites-backend/src/modules/assist-analytics/exp/experiment-math.ts',
    import.meta.url
  ).href
)) as { armOf: (s: string, v: string, share: number) => 'a' | 'b' };
let b = 0;
for (let i = 0; i < 2000; i++) {
  const v = 'v' + randomBytes(15).toString('base64url');
  assert.equal(armOf('salt-x', v, 0.1), server.armOf('salt-x', v, 0.1));
  if (armOf('salt-x', v, 0.1) === 'b') b++;
}
assert.ok(b > 120 && b < 280, `доля группы b ≈ 10%: ${b}/2000`);

// 3. «Не отслеживать»: GPC, DNT; Google Consent Mode из dataLayer.
assert.equal(doNotTrack({ globalPrivacyControl: true }, {}), true);
assert.equal(doNotTrack({ doNotTrack: '1' }, {}), true);
assert.equal(doNotTrack({}, { doNotTrack: '1' }), true);
assert.equal(doNotTrack({ doNotTrack: '0' }, {}), false);
function args(...a: unknown[]) {
  return (function (..._b: unknown[]) {
    // eslint-disable-next-line prefer-rest-params
    return arguments;
  })(...a);
}
assert.equal(gcmAnalytics(undefined), null);
assert.equal(
  gcmAnalytics([
    args('consent', 'default', { analytics_storage: 'denied' }),
    { event: 'gtm.js' },
  ]),
  false
);
assert.equal(
  gcmAnalytics([
    args('consent', 'default', { analytics_storage: 'denied' }),
    args('consent', 'update', { analytics_storage: 'granted' }),
  ]),
  true
);
assert.equal(shiftOf({ value: 0.1, hadRecentInput: true } as never), 0);
assert.equal(shiftOf({ value: 0.1, hadRecentInput: false } as never), 0.1);

// 4. Протокол: сообщение `ana` — строгий разбор.
const msg = (o: Record<string, unknown>) =>
  parseParentMessage(envelope({ type: 'ana', ...o } as never));
assert.deepEqual(
  msg({ visit: 'v'.repeat(20), greeting: { uk: 'Привіт' }, suggestions: null }),
  {
    type: 'ana',
    visit: 'v'.repeat(20),
    greeting: { uk: 'Привіт' },
    suggestions: null,
  }
);
assert.equal(
  msg({ visit: 'короткий', greeting: null, suggestions: null }),
  null
);
assert.equal(
  msg({ visit: null, greeting: { de: 'x' }, suggestions: null }),
  null
);
assert.equal(
  msg({
    v: null,
    greeting: null,
    suggestions: { uk: ['a', 'b', 'c', 'd', 'e'] },
  }),
  null
);

// 5. Линтер К-11: в bf.js нельзя слушать ввод и читать значения полей.
// eslint 8 без своих типов (а @types/eslint в зависимостях нет) — узкий тип
// здесь, чтобы `typecheck:scripts` был чистым (аудит Э3-бис).
type LintMessage = { ruleId: string | null; message: string };
type ESLintLike = new (o: { cwd: string }) => {
  lintText(
    code: string,
    o: { filePath: string }
  ): Promise<Array<{ messages: LintMessage[] }>>;
};
const { ESLint } = createRequire(import.meta.url)('eslint') as {
  ESLint: ESLintLike;
};
const eslint = new ESLint({
  cwd: new URL('..', import.meta.url).pathname,
});
const lint = async (code: string) =>
  (await eslint.lintText(code, { filePath: 'src/bf/fixture.ts' }))[0].messages
    .filter((m) => m.ruleId === 'no-restricted-syntax')
    .map((m) => m.message);
assert.ok(
  (await lint(`document.addEventListener('input', () => 0);\n`)).some((m) =>
    m.includes('К-11')
  ),
  "addEventListener('input') в bf.js — ошибка линтера"
);
assert.ok(
  (
    await lint(
      `const i = document.querySelector('input') as HTMLInputElement;\nexport const v = i.value;\n`
    )
  ).some((m) => m.includes('К-11')),
  '.value в bf.js — ошибка линтера'
);
assert.ok(
  (await lint(`document.addEventListener('keydown', () => 0);\n`)).length > 0
);
assert.deepEqual(
  await lint(`document.addEventListener('click', () => 0);\n`),
  [],
  'клик разрешён'
);

console.log('ana: ok');
