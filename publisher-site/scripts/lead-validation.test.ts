/**
 * Валидация формы ≡ сервер (проектный документ §16.8): одни и те же
 * векторы проходят через копию сайта (`src/shared/lead-validation.ts`) и
 * через ИСТОЧНИК `sites-backend/.../contracts/lead-validation.ts`; результаты
 * обязаны совпасть до поля. Плюс: копия = источник + шапка (тот же
 * `--check`, что в `npm test`), и форма сайта строит тело, которое
 * сервер принимает (для каждого способа связи).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as site from '../src/shared/lead-validation';
import { buildBody, EMPTY_FIELDS, validateFields, type LeadContext } from '../src/lib/lead-form';

const REPO = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO, 'sites-backend/src/modules/publisher/contracts/lead-validation.ts');

async function main() {
  const backend = (await import(pathToFileURL(SRC).href)) as Partial<typeof site> & { default?: typeof site };
  const be = (backend.validateLeadBody ? backend : backend.default) as typeof site;

  // 1. Копия = источник (байт-в-байт после шапки).
  const copy = fs.readFileSync(path.join(__dirname, '..', 'src/shared/lead-validation.ts'), 'utf8');
  const source = fs.readFileSync(SRC, 'utf8');
  assert.ok(
    copy.endsWith(source),
    'src/shared/lead-validation.ts разошлась с источником — node scripts/sync-shared.mjs',
  );

  // 2. Векторы.
  const base = {
    key: 'pp_standPublisherKey0000001',
    submissionKey: '3f1c2a9e-8b7d-4c6e-9f00-1234567890ab',
    name: 'Олена',
    contactMethod: 'email',
    contact: 'olena@example.com',
    business: 'https://shop.example',
    task: 'Потрібні матеріали для блогу',
    dataNoticeVersion: 'stand-1',
    consentState: 'not_required',
  };
  const vectors: unknown[] = [
    base,
    null,
    [],
    'x',
    {},
    { ...base, contactMethod: 'phone', contact: '+380 44 123 45 67' },
    { ...base, contactMethod: 'phone', contact: '12345' },
    { ...base, contactMethod: 'phone', contact: '+1234567890123456' },
    { ...base, contactMethod: 'telegram', contact: '@olena_shop' },
    { ...base, contactMethod: 'telegram', contact: 'https://t.me/olena_shop' },
    { ...base, contactMethod: 'telegram', contact: '@abc' },
    { ...base, contactMethod: 'telegram', contact: 'http://t.me/olena_shop' },
    { ...base, contactMethod: 'other', contact: 'ab' },
    { ...base, contactMethod: 'other', contact: 'Viber: 0441234567' },
    { ...base, contactMethod: 'fax' },
    { ...base, contact: 'not-an-email' },
    { ...base, contact: '  olena@example.com  ' },
    { ...base, name: '' },
    { ...base, name: '   ' },
    { ...base, name: 'я'.repeat(121) },
    { ...base, business: 'b'.repeat(301) },
    { ...base, task: 't'.repeat(2000) },
    { ...base, task: 't'.repeat(2001) },
    { ...base, task: '😀'.repeat(2000) },
    { ...base, budgetRange: '10k_30k' },
    { ...base, budgetRange: 'million' },
    { ...base, budgetRange: '' },
    { ...base, selfReported: { channel: 'search' } },
    { ...base, selfReported: { channel: 'tv' } },
    { ...base, selfReported: { channel: 'other', note: 'n'.repeat(301) } },
    { ...base, selfReported: 'search' },
    { ...base, dataNoticeVersion: '' },
    { ...base, dataNoticeVersion: 'v 1' },
    { ...base, consentState: 'yes' },
    { ...base, key: 'pk_live_x' },
    { ...base, submissionKey: 'not-a-uuid' },
    { ...base, submissionKey: '3F1C2A9E-8B7D-4C6E-9F00-1234567890AB' },
    { ...base, sessionRef: 'abc', contentSlug: 'Bad Slug', placementCode: '-x', utm: 'x' },
    {
      ...base,
      sessionRef: 'AbCdEf12_-',
      contentSlug: 'pershyi-material',
      placementCode: 'pl-1',
      utm: { source: 'tg' },
    },
    { ...base, hp: 'bot' },
    { ...base, hp: 1 },
    { ...base, elapsedMs: 120 },
    { ...base, elapsedMs: 5000.7 },
    { ...base, elapsedMs: -1 },
  ];
  let n = 0;
  for (const v of vectors) {
    assert.deepEqual(site.validateLeadBody(v), be.validateLeadBody(v), `вектор ${JSON.stringify(v)?.slice(0, 120)}`);
    n++;
  }
  for (const k of [
    'LEAD_CONTACT_METHODS',
    'LEAD_BUDGET_RANGES',
    'LEAD_CONSENT_STATES',
    'LEAD_SELF_REPORTED_CHANNELS',
    'LEAD_TASK_MAX',
  ] as const) {
    assert.deepEqual(site[k], be[k], k);
  }

  // 3. Тело формы сайта сервер принимает — для каждого способа связи.
  const ctx: LeadContext = {
    publicKey: 'pp_standPublisherKey0000001',
    dataNoticeVersion: 'stand-1',
    consentState: 'not_required',
    attribution: { sessionRef: 'AbCdEf12_-xyz', utm: { source: 'tg' }, placementCode: 'pl-1' },
    contentSlug: 'pershyi-material',
    elapsedMs: 4321,
    hp: '',
  };
  const contacts = {
    email: 'olena@example.com',
    phone: '+380441234567',
    telegram: '@olena_shop',
    other: 'Viber 0441234567',
  } as const;
  for (const m of site.LEAD_CONTACT_METHODS) {
    const f = {
      ...EMPTY_FIELDS,
      name: 'Олена',
      contactMethod: m,
      contact: contacts[m],
      business: 'shop.example',
      task: 'Задача',
      budgetRange: '30k_100k' as const,
      selfReported: 'search' as const,
    };
    assert.deepEqual(validateFields(f, ctx), {}, `форма ${m}: клиентская проверка`);
    const r = be.validateLeadBody(buildBody(f, ctx, '3f1c2a9e-8b7d-4c6e-9f00-1234567890ab'));
    assert.ok(r.ok, `форма ${m}: сервер отверг ${JSON.stringify(!r.ok && r.fields)}`);
    if (r.ok) {
      assert.equal(r.value.sessionRef, 'AbCdEf12_-xyz');
      assert.equal(r.value.contentSlug, 'pershyi-material');
      assert.equal(r.value.selfReportedChannel, 'search');
      assert.equal(r.trap, false);
      assert.deepEqual(r.dropped, []);
    }
  }
  console.log(
    `ok   lead-validation: копия ≡ источник; ${n} векторов совпали с сервером; тело формы принимается для ${site.LEAD_CONTACT_METHODS.length} способов связи`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
