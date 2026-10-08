/**
 * Э6-бис (б): вкладка «Голос» «Админки» — повтор типов сервера (коды
 * ошибок, редакция рисков, поля вида настроек), словари uk/ru/en (одни и
 * те же ключи), строгий разбор, клиент (пути, тело).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADMIN_VOICE_TEXTS } from '../src/i18n/admin-voice';
import type { ApiClient } from '../src/kit';
import {
  ADMIN_VC_ERROR_CODES,
  ADMIN_VC_ITEM_CODES,
  ADMIN_VC_MIC_STATUSES,
  ADMIN_VC_PROBE_KINDS,
  ADMIN_VC_RISKS_VERSION,
  adminVoiceItemText,
  createAdminVoiceApi,
  parseAdminVoiceSettings,
} from '../src/lib/admin-voice-api';
import { ADMIN_MODE_TABS } from '../src/lib/admin-mode-api';

const BACK = new URL(
  '../../sites-backend/src/modules/assist-admin-voice/',
  import.meta.url
);
const read = (f: string) => readFileSync(new URL(f, BACK), 'utf8');

// 1. Коды ошибок и редакция рисков — те же, что у сервера.
{
  const errs = read('admin-voice-errors.ts');
  const m = /export type AdminVoiceErrorCode =([^;]+);/.exec(errs);
  assert.ok(m, 'нет AdminVoiceErrorCode на сервере');
  assert.deepEqual(
    [...m![1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]),
    [...ADMIN_VC_ERROR_CODES]
  );
  const rules = read('admin-voice-rules.ts');
  assert.ok(
    rules.includes(`ADMIN_VC_RISKS_VERSION = '${ADMIN_VC_RISKS_VERSION}'`),
    'редакция рисков TMA ≠ сервера'
  );
  // Поля вида настроек — все, что отдаёт сервер (api-types.ts).
  const types = read('api-types.ts');
  const body = /export interface AdminVoiceSettingsView \{([\s\S]*?)\n\}/.exec(
    types
  );
  assert.ok(body);
  const keys = [...body![1].matchAll(/^\s{2}(\w+):/gm)].map((x) => x[1]);
  const parsed = parseAdminVoiceSettings({});
  for (const k of keys)
    assert.ok(k in parsed, `TMA не разбирает поле ${k} вида настроек`);
}

// 2. Словари: одни и те же ключи, риски — столько же пунктов.
{
  const shape = (o: unknown): unknown =>
    o && typeof o === 'object' && !Array.isArray(o)
      ? Object.fromEntries(
          Object.entries(o as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, shape(v)])
        )
      : Array.isArray(o)
        ? o.length
        : typeof o;
  assert.deepEqual(shape(ADMIN_VOICE_TEXTS.ru), shape(ADMIN_VOICE_TEXTS.uk));
  assert.deepEqual(shape(ADMIN_VOICE_TEXTS.en), shape(ADMIN_VOICE_TEXTS.uk));
  // Тексты ошибок — только для известных кодов сервера.
  for (const k of Object.keys(ADMIN_VOICE_TEXTS.uk.errors))
    assert.ok((ADMIN_VC_ERROR_CODES as readonly string[]).includes(k), k);
  assert.ok(ADMIN_MODE_TABS.includes('voice'));
}

// 3. Строгий разбор: мусор — умолчания, лишнее — мимо.
{
  const v = parseAdminVoiceSettings({
    state: 'evil',
    rules: { maxSteps: 99, denySelectors: ['.a', 5] },
    hosts: [{ id: 'h1', host: 'admin.shop.com', verified: true, test: 'yes' }],
    report: { id: 't1', result: 'maybe', attempts: -3, problem: 'x' },
    onProblem: 'failed',
    metrics: { plans: 3, done: 'many' },
    secret: 'S',
  });
  assert.equal(v.state, 'off');
  assert.equal(v.rules.maxSteps, 10);
  assert.deepEqual(v.rules.denySelectors, ['.a']);
  assert.equal(v.hosts[0].test, false);
  assert.equal(v.report?.result, null);
  assert.equal(v.report?.attempts, 0);
  assert.equal(v.report?.problem, null);
  assert.equal(v.onProblem, 'failed');
  assert.equal(v.metrics.plans, 3);
  assert.equal(v.metrics.done, 0);
  assert.equal(JSON.stringify(v).includes('"S"'), false);
}

// 4. Клиент: пути, тело, ссылка мастера — только https.
{
  const calls: Array<[string, string, unknown]> = [];
  const client: ApiClient = {
    request: async <T>(method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      if (path.endsWith('/test-token'))
        return {
          testId: 't1',
          url: 'javascript:alert(1)',
          expiresAt: new Date().toISOString(),
          testHost: true,
        } as T;
      if (path.endsWith('/tests')) return [{ id: 't1' }] as T;
      return {} as T;
    },
  } as ApiClient;
  const api = createAdminVoiceApi(client);
  await api.get('s1');
  await api.patch('s1', {
    state: 'test',
    risksVersion: ADMIN_VC_RISKS_VERSION,
    siteName: 'Shop',
  });
  const tok = await api.testToken('s1', { hostId: 'h1', path: '/orders' });
  assert.equal(tok.url, '', 'не-https ссылка мастера отброшена');
  await api.tests('s1');
  await api.test('s1', 't1');
  assert.deepEqual(
    calls.map(([mth, p]) => `${mth} ${p}`),
    [
      'GET /assist/sites/s1/admin-mode/voice-control',
      'PATCH /assist/sites/s1/admin-mode/voice-control',
      'POST /assist/sites/s1/admin-mode/voice-control/test-token',
      'GET /assist/sites/s1/admin-mode/voice-control/tests',
      'GET /assist/sites/s1/admin-mode/voice-control/tests/t1',
    ]
  );
  assert.deepEqual(calls[1][2], {
    state: 'test',
    risksVersion: ADMIN_VC_RISKS_VERSION,
    siteName: 'Shop',
  });
  await assert.rejects(api.get('a/b'));
  await assert.rejects(api.test('s1', '../x'));
}

// 5. (аудит Э6-бис (б) (1)) Коды пунктов отчёта и виды проб — те же, что
// у сервера; на каждый код — человеческий текст во всех языках.
{
  const wiz = readFileSync(
    new URL('../assist-ui-core/wizard.ts', BACK),
    'utf8'
  );
  const m = /export type WizardItemCode =([\s\S]+?);/.exec(wiz);
  assert.ok(m, 'нет WizardItemCode на сервере');
  assert.deepEqual(
    ['ok', ...[...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])],
    [...ADMIN_VC_ITEM_CODES]
  );
  const rules = read('admin-voice-rules.ts');
  const k = /export const ADMIN_PROBE_KINDS = \[([^\]]+)\]/.exec(rules);
  assert.ok(k, 'нет ADMIN_PROBE_KINDS на сервере');
  assert.deepEqual(
    [...k![1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]),
    [...ADMIN_VC_PROBE_KINDS]
  );
  // Состояния микрофона — те же, что MicStatus сервера.
  const ms = /export type MicStatus =([\s\S]+?);/.exec(wiz);
  assert.ok(ms, 'нет MicStatus на сервере');
  assert.deepEqual(
    [...ms![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]),
    [...ADMIN_VC_MIC_STATUSES]
  );
  for (const lang of ['uk', 'ru', 'en'] as const) {
    const w = ADMIN_VOICE_TEXTS[lang].wizard;
    for (const m of ADMIN_VC_MIC_STATUSES) assert.ok(w.mic[m], `${lang} ${m}`);
    for (const c of ADMIN_VC_ITEM_CODES)
      assert.ok(w.items[c] && !/^[a-z_]+$/.test(w.items[c]), `${lang} ${c}`);
    for (const p of ADMIN_VC_PROBE_KINDS) assert.ok(w.probes[p], p);
  }
  // Числа пункта подставлены; ни одного «{…}» и ни одного сырого кода.
  const uk = ADMIN_VOICE_TEXTS.uk.wizard.items;
  const dry = adminVoiceItemText(uk, {
    step: 4,
    level: 'fail',
    code: 'dry_low',
    data: { ok: 1, need: 3 },
  });
  assert.equal(dry, 'Крок 4: сухий прогін — вірних кроків 1, потрібно 3');
  const leak = adminVoiceItemText(uk, {
    step: 6,
    level: 'fail',
    code: 'forbidden_leak',
    data: { attempts: 2, submitOnWork: 0 },
  });
  assert.ok(leak.includes('2') && !leak.includes('{'), leak);
  assert.notEqual(
    leak,
    adminVoiceItemText(uk, {
      step: 6,
      level: 'fail',
      code: 'forbidden_leak',
      data: { n: 1 },
    }),
    'попытки на странице — свой текст, не «проба не заблокирована»'
  );
  const mic = ADMIN_VOICE_TEXTS.uk.wizard.mic;
  const micItem = (status: string) =>
    adminVoiceItemText(
      uk,
      { step: 2, level: 'warn', code: 'mic_owner_problem', data: { status } },
      mic
    );
  assert.ok(micItem('evil_code').includes('(—)'), micItem('evil_code'));
  assert.ok(!micItem('evil_code').includes('evil'));
  assert.ok(micItem('denied_user').includes('доступ не дано в браузері'));
  const unknown = adminVoiceItemText(uk, {
    step: 3,
    level: 'warn',
    code: null,
    data: {},
  });
  assert.equal(unknown, uk.unknown.replace('{step}', '3'));
  // Сервер выдаёт пункты с такими данными — все тексты без «{…}».
  const sample: Record<string, Record<string, number | string>> = {
    csp_violations: { n: 2 },
    tt_violations: { n: 1 },
    mic_owner_problem: { status: 'denied_user' },
    safe_low: { done: 1, of: 3 },
    forbidden_leak: { n: 2 },
    suspicious_unreviewed: { n: 4 },
    unnamed_elements: { n: 1 },
    closed_shadow: { n: 1 },
    ext_iframes: { n: 1 },
    duplicates: { n: 1 },
    undo_unresolved: { n: 1, of: 2 },
    dry_low: { ok: 0, need: 3 },
  };
  for (const lang of ['uk', 'ru', 'en'] as const)
    for (const c of ADMIN_VC_ITEM_CODES) {
      const w = ADMIN_VOICE_TEXTS[lang].wizard;
      const txt = adminVoiceItemText(
        w.items,
        { step: 1, level: 'warn', code: c, data: sample[c] ?? {} },
        w.mic
      );
      // Целиком: ни «{…}», ни «?», ни сырого кода (`denied_user`).
      assert.ok(!/[{}?]|[a-z]+_[a-z]+/.test(txt), `${lang} ${c}: ${txt}`);
    }
}

// 6. Разбор отчёта: коды — из списка (неизвестный — null), данные пункта —
// только числа и коды, проба — известный вид, фрагмент и сухой прогон.
{
  const client: ApiClient = {
    request: async <T>() =>
      ({
        id: 't1',
        result: 'partial',
        reportedAt: new Date().toISOString(),
        report: {
          result: 'partial',
          items: [
            {
              step: 4,
              level: 'fail',
              code: 'dry_low',
              data: { ok: 1, need: 3 },
            },
            {
              step: 2,
              level: 'warn',
              code: 'mic_owner_problem',
              data: { status: 'denied_user', name: 'Іван Петренко' },
            },
            { step: 9, level: 'warn', code: 'evil_code<script>' },
          ],
          forbidden: [
            {
              kind: 'cancel',
              command: 'скасуй замовлення',
              blocked: true,
              api: 'shop.cancelOrder',
            },
            { kind: 'x', command: 'y', blocked: false, api: null },
          ],
          dry: [{ command: 'відкрий Клієнти', steps: 2, ok: 1, planId: 'p1' }],
          fragment: '<!-- x --> <button data-assist="never">',
        },
      }) as T,
  } as ApiClient;
  const d = await createAdminVoiceApi(client).test('s1', 't1');
  const r = d.report!;
  assert.deepEqual(r.items[0], {
    step: 4,
    level: 'fail',
    code: 'dry_low',
    data: { ok: 1, need: 3 },
  });
  assert.deepEqual(r.items[1].data, { status: 'denied_user' }, 'ПД мимо');
  assert.equal(r.items[2].code, null);
  assert.equal(r.forbidden[0].kind, 'cancel');
  assert.equal(r.forbidden[1].kind, null);
  assert.deepEqual(r.dry, [{ command: 'відкрий Клієнти', steps: 2, ok: 1 }]);
  assert.ok(r.fragment.includes('data-assist="never"'));
  assert.ok(
    !adminVoiceItemText(ADMIN_VOICE_TEXTS.ru.wizard.items, r.items[2]).includes(
      'evil'
    )
  );
}

console.log('admin-voice-api: ok');
