/**
 * Э6-бис (а): кабинет голосового управления в TMA — повтор типов сервера
 * (коды ошибок, причины «выключено», состояния, версия текста рисков),
 * словари uk/ru/en, строгий разбор, клиент (пути, тело, risksVersion).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appEn } from '../src/i18n/en';
import { appRu } from '../src/i18n/ru';
import { appUk } from '../src/i18n/uk';
import { ApiError, type ApiClient } from '../src/kit';
import {
  VOICE_CONTROL_CABINET_ERROR_CODES,
  VOICE_CONTROL_OFF_REASONS,
  VOICE_CONTROL_STATES,
  MONITOR_CODES,
  REPORT_PROBLEMS,
  WIZARD_ITEM_CODES,
  createVoiceControlApi,
  defaultRules,
  lines,
  parseTestDetail,
  parseVoiceControlSettings,
  pct,
  voiceControlErrorCode,
} from '../src/lib/voice-control-api';

const BACK = new URL('../../sites-backend/src/modules/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, BACK), 'utf8');
const quoted = (src: string, re: RegExp) => {
  const m = re.exec(src);
  assert.ok(m, `нет ${re} на сервере`);
  return [...m![1].matchAll(/'([A-Za-z_-]+)'/g)].map((x) => x[1]);
};

// 1. Коды, причины, состояния — те же, что у сервера; версия рисков — есть.
{
  const types = read('assist-site-voice-control/api-types.ts');
  assert.deepEqual(
    quoted(
      types,
      /VOICE_CONTROL_CABINET_ERROR_CODES = \[([\s\S]*?)\] as const/
    ),
    [...VOICE_CONTROL_CABINET_ERROR_CODES]
  );
  assert.ok(/VOICE_CONTROL_RISKS_VERSION = '[a-z0-9-]+'/.test(types));
  const cfg = read('assist-site-voice-control/voice-control-config.ts');
  assert.deepEqual(
    quoted(cfg, /export type VoiceControlOffReason =([^;]+);/).sort(),
    [...VOICE_CONTROL_OFF_REASONS].sort()
  );
  const core = read('assist-ui-core/types.ts');
  assert.deepEqual(
    quoted(core, /VOICE_CONTROL_STATES = \[([\s\S]*?)\] as const/),
    [...VOICE_CONTROL_STATES]
  );
  const rules = read('assist-ui-core/rules.ts');
  assert.ok(/siteDefaultSteps: 6/.test(rules));
  assert.ok(/maxStepsCap: 15/.test(rules));
  // Э6-бис (г): проблемы отчёта, пункты мастера, коды монитора — как у сервера.
  const wiz = read('assist-ui-core/wizard.ts');
  assert.deepEqual(quoted(wiz, /export type ReportProblem =([^;]+);/), [
    ...REPORT_PROBLEMS,
  ]);
  assert.deepEqual(
    quoted(wiz, /export type WizardItemCode =([^;]+);/),
    WIZARD_ITEM_CODES.filter((c) => c !== 'ok')
  );
  const mon = read('assist-site-voice-control/monitor-rules.ts');
  for (const c of quoted(mon, /export type MonitorCode =([^;]+);/))
    assert.ok((MONITOR_CODES as readonly string[]).includes(c), c);
}

// 2. Словари: каждая причина и код — на трёх языках; рисков ≥ 5, одинаково.
for (const d of [appUk, appRu, appEn]) {
  const v = d.voiceControl;
  for (const r of VOICE_CONTROL_OFF_REASONS)
    assert.ok(v.reasons[r], `нет причины ${r}`);
  for (const c of VOICE_CONTROL_CABINET_ERROR_CODES)
    assert.ok(v.errors[c], `нет кода ${c}`);
  assert.ok(v.risks.items.length >= 5);
  assert.equal(v.risks.items.length, appRu.voiceControl.risks.items.length);
  for (const s of VOICE_CONTROL_STATES) {
    assert.ok(v.states[s], `нет состояния ${s}`);
    assert.ok(v.stateHelp[s], `нет подсказки ${s}`);
  }
  for (const p of REPORT_PROBLEMS) assert.ok(v.wizard.problems[p], p);
  for (const c of WIZARD_ITEM_CODES) assert.ok(v.wizard.items[c], c);
  for (const c of MONITOR_CODES)
    assert.ok((v.stateReasons as Record<string, string>)[c], c);
  assert.ok(v.banner.includes('{date}'));
}

// 3. Разбор строгий: мусор — умолчания.
{
  const v = parseVoiceControlSettings({
    siteId: 's1',
    state: 'evil',
    rules: {
      denySelectors: ['.a', 5, 'x'.repeat(300)],
      maxSteps: 99,
      confirmFill: 'yes',
    },
    available: 'true',
    reason: 'nope',
    risksVersion: '<b>',
  });
  assert.equal(v.state, 'off');
  assert.deepEqual(v.rules.denySelectors, ['.a']);
  assert.equal(v.rules.maxSteps, 6);
  assert.equal(v.rules.confirmFill, false);
  assert.equal(v.available, false);
  assert.equal(v.reason, null);
  assert.equal(v.risksVersion, '');
  assert.deepEqual(lines(' /a* \n\n /b '), ['/a*', '/b']);
  assert.equal(v.lastTest, null);
  assert.equal(v.monitor, null);
  assert.equal(pct(1, 3), '33%');
  assert.equal(pct(0, 0), '—');
}

// 3а. Э6-бис (г): отчёт мастера и сводка — строго, мусор отбрасывается.
{
  const v = parseVoiceControlSettings({
    siteId: 's1',
    state: 'test',
    reason: 'state_test',
    stateBy: 'transition',
    stateAt: '2026-10-03T10:00:00.000Z',
    checkDeadline: 'nope',
    plansPerDay: 300,
    lastTest: {
      id: 't1',
      kind: 'wizard',
      host: 'a.example',
      createdAt: '2026-10-03T10:00:00.000Z',
      result: 'partial',
      problem: 'partial_ack',
      release: '<script>',
    },
    monitor: {
      windowHours: 24,
      metrics: { plans: 10, done: 7, latencyP50Ms: -1 },
      incidents: [{ kind: 'alert', code: 'done_low', createdAt: 'x' }],
    },
  });
  assert.equal(v.state, 'test');
  assert.equal(v.reason, 'state_test');
  assert.equal(v.stateBy, 'transition');
  assert.equal(v.checkDeadline, null);
  assert.equal(v.plansPerDay, 300);
  assert.equal(v.lastTest?.result, 'partial');
  assert.equal(v.lastTest?.problem, 'partial_ack');
  assert.equal(v.lastTest?.release, null);
  assert.equal(v.monitor?.metrics.done, 7);
  assert.equal(v.monitor?.metrics.latencyP50Ms, null);
  assert.equal(v.monitor?.incidents[0].code, 'done_low');
  assert.equal(parseTestDetail({ id: '../x' }), null);
  const d = parseTestDetail({
    id: 't1',
    report: {
      result: 'fail',
      items: [
        { step: 2, level: 'fail', code: 'mic_policy_denied' },
        { step: 9, code: 'evil' },
      ],
      forbidden: [
        { kind: 'pay', command: 'оплати', blocked: false, candidates: 1 },
      ],
      markup: { total: 5, withId: 3, unnamed: [1, 2] },
    },
  });
  assert.equal(d?.report?.result, 'fail');
  assert.equal(d?.report?.items[0].code, 'mic_policy_denied');
  assert.equal(d?.report?.items[1].code, 'ok');
  assert.equal(d?.report?.items[1].step, 7);
  assert.equal(d?.report?.forbidden[0].blocked, false);
  assert.equal(d?.report?.markup.unnamed, 2);
  assert.equal(
    parseTestDetail({ id: 't2', report: { result: '?' } })?.report,
    null
  );
}

// 4. Клиент: пути и тело (risksVersion — только при включении).
async function main() {
  const calls: Array<[string, string, unknown]> = [];
  const client: ApiClient = {
    request: async <T>(method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return {
        siteId: 's1',
        state: 'on',
        rules: {},
        available: true,
        risksVersion: 'site-risks-1',
      } as T;
    },
  };
  const api = createVoiceControlApi(client);
  await api.get('s1');
  await api.save('s1', {
    state: 'on',
    rules: defaultRules(),
    risksVersion: 'site-risks-1',
  });
  assert.deepEqual(calls[0], [
    'GET',
    '/assist/sites/s1/voice-control/site',
    undefined,
  ]);
  assert.deepEqual(calls[1][2], {
    state: 'on',
    rules: defaultRules(),
    risksVersion: 'site-risks-1',
  });
  await assert.rejects(api.get('../x'));
  // Э6-бис (г): ссылка мастера, список и отчёт.
  const c2: Array<[string, string, unknown]> = [];
  const api2 = createVoiceControlApi({
    request: async <T>(method: string, path: string, body?: unknown) => {
      c2.push([method, path, body]);
      if (path.endsWith('/test-token'))
        return {
          testId: 't1',
          url:
            (body as { host?: string }).host === 'evil'
              ? 'javascript:alert(1)'
              : 'https://a.example/?v4c_voicetest=abc',
          expiresAt: '2026-10-03T10:30:00.000Z',
        } as T;
      if (path.endsWith('/tests'))
        return { items: [{ id: 't1' }, { id: '../' }] } as T;
      return { id: 't1', report: null } as T;
    },
  });
  const tok = await api2.testToken('s1', { host: 'a.example' });
  assert.equal(tok.url, 'https://a.example/?v4c_voicetest=abc');
  assert.deepEqual(c2[0], [
    'POST',
    '/assist/sites/s1/voice-control/site/test-token',
    { host: 'a.example' },
  ]);
  await assert.rejects(api2.testToken('s1', { host: 'evil' }));
  assert.equal((await api2.tests('s1')).length, 1);
  assert.equal((await api2.test('s1', 't1'))?.id, 't1');
  assert.equal(
    c2[c2.length - 1][1],
    '/assist/sites/s1/voice-control/site/tests/t1'
  );
  await assert.rejects(api2.test('s1', '../t'));
  assert.equal(
    voiceControlErrorCode(
      new ApiError('VOICE_CONTROL_TEST_REQUIRED', 'x', 409)
    ),
    'VOICE_CONTROL_TEST_REQUIRED'
  );
  assert.equal(
    voiceControlErrorCode(
      new ApiError('VOICE_CONTROL_RISKS_REQUIRED', 'x', 400)
    ),
    'VOICE_CONTROL_RISKS_REQUIRED'
  );
  assert.equal(voiceControlErrorCode(new ApiError('OTHER', 'x', 400)), null);
  console.log('voice-control-api: типы сервера, словари, разбор, клиент — ok');
}
void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
