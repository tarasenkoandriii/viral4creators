/**
 * Логика формы (§13.4; AT-CORE-02/03/04 — интерфейсная часть): успех ТОЛЬКО
 * по 200/201 с `leadRef`; всё прочее — «не відправлено» нужного вида;
 * ошибки полей по способу связи; отпечаток попытки (тот же ⇒ тот же ключ).
 */
import assert from 'node:assert/strict';
import {
  classifyResponse,
  EMPTY_FIELDS,
  fingerprint,
  firstInvalid,
  mapIssues,
  validateFields,
  waitParts,
  type LeadContext,
} from '../src/lib/lead-form';

let n = 0;
const eq = (a: unknown, b: unknown, m: string) => {
  n++;
  assert.deepEqual(a, b, m);
};
const okBody = (leadRef: unknown) => ({
  success: true,
  data: { leadRef, receivedAt: '2026-10-13T10:00:00Z', eventId: 'e' },
});
const errBody = (code: string, details?: unknown) => ({ success: false, error: { code, message: 'x', details } });

// Успех — только с номером.
eq(
  classifyResponse(201, okBody('L-ABCDEFGH23'), 'email'),
  { kind: 'success', leadRef: 'L-ABCDEFGH23' },
  '201 + leadRef',
);
eq(
  classifyResponse(200, okBody('L-ABCDEFGH23'), 'email'),
  { kind: 'success', leadRef: 'L-ABCDEFGH23' },
  '200 повтор + тот же leadRef',
);
eq(classifyResponse(201, okBody(undefined), 'email').kind, 'server', '201 без leadRef — не успех');
eq(classifyResponse(201, okBody('<b>x</b>'), 'email').kind, 'server', 'чужой формат номера — не успех');
eq(classifyResponse(201, null, 'email').kind, 'server', '201 без тела (HTML прокси) — не успех');
eq(classifyResponse(202, okBody('L-ABCDEFGH23'), 'email').kind, 'server', '202 — не успех');
eq(
  classifyResponse(201, { success: false, data: { leadRef: 'L-ABCDEFGH23' } }, 'email').kind,
  'server',
  'success:false — не успех',
);
// Ошибки.
eq(
  classifyResponse(
    400,
    errBody('PUB_VALIDATION', {
      fields: [
        { field: 'contact', code: 'format' },
        { field: 'task', code: 'length' },
      ],
    }),
    'phone',
  ),
  { kind: 'validation', errors: { contact: 'phone', task: 'taskLength' } },
  '400 → ошибки у полей',
);
eq(
  classifyResponse(
    400,
    errBody('PUB_VALIDATION', { fields: [{ field: 'dataNoticeVersion', code: 'format' }] }),
    'phone',
  ).kind,
  'server',
  '400 по полю вне формы — не вина посетителя',
);
eq(
  classifyResponse(
    429,
    errBody('PUB_RATE_LIMITED', { retryAfterSec: 125, altContact: { label: 'a' } }),
    'email',
    '600',
  ),
  { kind: 'rate_limited', retryAfterSec: 125, altContact: { label: 'a' } },
  '429: время из details',
);
eq(
  classifyResponse(429, errBody('PUB_RATE_LIMITED'), 'email', '90'),
  { kind: 'rate_limited', retryAfterSec: 90, altContact: null },
  '429: время из Retry-After',
);
eq(
  classifyResponse(503, errBody('PUB_FORM_CLOSED', { altContact: { label: 'b' }, reason: 'closed' }), 'email'),
  { kind: 'closed', altContact: { label: 'b' } },
  '503 закрыта',
);
eq(classifyResponse(503, errBody('PUB_BUSY'), 'email').kind, 'server', '503 занято — повтор тем же ключом');
eq(classifyResponse(503, errBody('PUB_CONTACT_KEY_MISSING'), 'email').kind, 'server', '503 без ключа шифрования');
eq(classifyResponse(500, null, 'email').kind, 'server', '500');
eq(classifyResponse(409, errBody('PUB_IDEMPOTENCY_REUSED'), 'email').kind, 'reused', '409 — новый ключ');
eq(classifyResponse(403, errBody('PUB_ORIGIN_DENIED'), 'email').kind, 'server', '403');
eq(classifyResponse(413, errBody('PUB_PAYLOAD_TOO_LARGE'), 'email').kind, 'server', '413');

// Ошибки полей по способу связи.
const ctx: LeadContext = {
  publicKey: 'pp_standPublisherKey0000001',
  dataNoticeVersion: 'stand-1',
  consentState: 'not_required',
  attribution: {},
  elapsedMs: 3000,
  hp: '',
};
const empty = validateFields(EMPTY_FIELDS, ctx);
eq(
  empty,
  { name: 'required', contactMethod: 'method', contact: 'required', business: 'required', task: 'required' },
  'пустая форма',
);
eq(firstInvalid(empty), 'name', 'фокус — на первое ошибочное');
const base = { ...EMPTY_FIELDS, name: 'Олена', business: 'shop', task: 'Задача' };
eq(validateFields({ ...base, contactMethod: 'email', contact: 'olena@' }, ctx), { contact: 'email' }, 'email');
eq(validateFields({ ...base, contactMethod: 'phone', contact: '12-34' }, ctx), { contact: 'phone' }, 'телефон');
eq(validateFields({ ...base, contactMethod: 'telegram', contact: 'ab' }, ctx), { contact: 'telegram' }, 'telegram');
eq(validateFields({ ...base, contactMethod: 'other', contact: 'ab' }, ctx), { contact: 'other' }, 'другое');
eq(validateFields({ ...base, contactMethod: 'other', contact: 'Viber 044' }, ctx), {}, 'другое — годно');
eq(
  validateFields({ ...base, contactMethod: 'email', contact: 'a@b.ua', task: 'x'.repeat(2001) }, ctx),
  { task: 'taskLength' },
  'задача > 2000',
);
eq(
  validateFields({ ...base, contactMethod: 'email', contact: 'a@b.ua', name: 'я'.repeat(121) }, ctx),
  { name: 'nameLength' },
  'имя > 120',
);
eq(
  firstInvalid(validateFields({ ...base, name: '', contactMethod: 'email', contact: 'bad' }, ctx)),
  'name',
  'порядок полей',
);
eq(
  mapIssues(
    [
      { field: 'selfReported.channel', code: 'enum' },
      { field: 'budgetRange', code: 'enum' },
    ],
    'email',
  ),
  { selfReported: 'enum', budgetRange: 'enum' },
  'необязательные поля',
);

// Отпечаток попытки.
const f1 = { ...base, contactMethod: 'email' as const, contact: 'a@b.ua' };
eq(fingerprint(f1) === fingerprint({ ...f1 }), true, 'те же поля — тот же отпечаток (повтор тем же ключом)');
eq(fingerprint(f1) === fingerprint({ ...f1, task: 'Задача!' }), false, 'правка поля — новый отпечаток (новый ключ)');

// Время ожидания 429.
eq(waitParts(125), { unit: 'minutes', n: 3 }, 'минуты вверх');
eq(waitParts(30), { unit: 'seconds', n: 30 }, 'секунды');
eq(waitParts(null), { unit: 'minutes', n: 10 }, 'неизвестно — окно 600 с');
console.log(
  `ok   lead-form: ${n} проверок — успех только с leadRef, 400/409/429/503/5xx, ошибки полей по способу связи, отпечаток попытки`,
);
