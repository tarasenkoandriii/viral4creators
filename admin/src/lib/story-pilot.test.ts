// Story‑Tales, проход 3: раздел «Пилот» Админки — запросы (адрес, метод,
// тело с причиной и requestId, DELETE с телом), места и блокировка
// «Одобрить», подписи режима и ошибки словами (коды backend
// `story-pilot.service.ts`).
// Запуск (из admin/): npx tsx src/lib/story-pilot.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ApiRequestError } from './admin-api';
import {
  PILOT_ACTION_EFFECT,
  PILOT_ACTION_TITLE,
  PILOT_DEFAULT_REASON,
  PILOT_APPLICATION_STATUS,
  PILOT_MODE_LABEL,
  PILOT_OWNER_CHECKLIST,
  approveBlockedReason,
  approveStoryPilotApplication,
  getStoryPilot,
  kyivDate,
  pilotErrorCode,
  pilotErrorNeedsReload,
  pilotErrorText,
  pilotModeNote,
  pilotUserLabel,
  pilotSeats,
  rejectStoryPilotApplication,
  revokeStoryPilotMember,
} from './story-pilot';
import type { StoryPilotApplication, StoryPilotMember, StoryPilotOverview } from './types';

const member = (n: number): StoryPilotMember => ({
  userId: `0000000${n}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
  shortId: `0000000${n}`,
  since: '2026-10-20T09:00:00.000Z',
  freeGiftUsed: n % 2 === 0,
  giftsCount: n,
});
const app = (status: StoryPilotApplication['status']): StoryPilotApplication => ({
  id: `app-${status}`,
  userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  shortId: 'bbbbbbbb',
  scenario: null,
  status,
  createdAt: '2026-10-20T10:00:00.000Z',
});
const overview = (members: number, max = 15): StoryPilotOverview => ({
  mode: 'pilot',
  maxMembers: max,
  members: Array.from({ length: members }, (_, i) => member(i + 1)),
  applications: [app('pending'), app('rejected')],
});

async function main() {
  // ── Запросы ──
  const calls: Array<{ url: string; method: string; body: unknown; credentials?: RequestCredentials }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      credentials: init?.credentials,
    });
    return new Response(JSON.stringify({ success: true, data: { journalId: 'j1', replayed: false } }), { status: 200 });
  }) as typeof fetch;
  const rid = '9b2f4f7e-1c1a-4f6e-9d55-3c0a3f7b2a10';
  await getStoryPilot();
  await approveStoryPilotApplication('app/1', { requestId: rid, reason: 'семья из списка' });
  await rejectStoryPilotApplication('app-2', { requestId: rid });
  await revokeStoryPilotMember('user 3', { requestId: rid, reason: 'по просьбе' });
  assert.deepEqual(
    calls.map((c) => [c.method, c.url.replace(/^.*\/api/, '')]),
    [
      ['GET', '/admin/story-tales/pilot'],
      ['POST', '/admin/story-tales/pilot/applications/app%2F1/approve'],
      ['POST', '/admin/story-tales/pilot/applications/app-2/reject'],
      ['DELETE', '/admin/story-tales/pilot/members/user%203'],
    ],
    'адреса и методы контракта; id экранированы',
  );
  assert.deepEqual(calls[1].body, { requestId: rid, reason: 'семья из списка' });
  assert.deepEqual(calls[2].body, { requestId: rid }, 'без причины — сервер подставит стандартную');
  assert.deepEqual(calls[3].body, { requestId: rid, reason: 'по просьбе' }, 'DELETE несёт тело с причиной');
  assert.equal(calls[0].body, undefined);
  assert.ok(calls.every((c) => c.credentials === 'include'), 'cookie AdminSession на каждом запросе');

  // ── Места и «Одобрить» ──
  assert.deepEqual(pilotSeats(overview(3)), { used: 3, max: 15, left: 12, full: false });
  assert.deepEqual(pilotSeats(overview(15)), { used: 15, max: 15, left: 0, full: true });
  assert.deepEqual(pilotSeats(overview(16)), { used: 16, max: 15, left: 0, full: true }, 'лимит уменьшили ниже занятых');
  assert.equal(approveBlockedReason(overview(3), app('pending')), null);
  assert.match(approveBlockedReason(overview(15), app('pending')) ?? '', /мест нет: занято 15 из 15/);
  assert.match(approveBlockedReason(overview(3), app('approved')) ?? '', /рассмотрена/);

  // ── Режим ──
  assert.equal(pilotModeNote('pilot'), null);
  assert.match(pilotModeNote('owner') ?? '', /только владельцу/);
  assert.match(pilotModeNote('public') ?? '', /Открытый режим/);
  for (const mode of ['owner', 'pilot', 'public'] as const) assert.match(PILOT_MODE_LABEL[mode], new RegExp(`STORY_TALES_ACCESS=${mode}`));

  // ── Подтверждения: что будет, и причина по умолчанию ──
  for (const k of ['approve', 'reject', 'revoke'] as const) {
    assert.ok(PILOT_ACTION_TITLE[k] && PILOT_ACTION_EFFECT[k].length > 40, `${k}: текст подтверждения`);
    assert.ok(PILOT_DEFAULT_REASON[k].trim().length >= 3, `${k}: стандартная причина короче 3 символов`);
  }
  assert.match(PILOT_ACTION_EFFECT.revoke, /остаются/, 'отзыв: данные пользователя остаются');
  assert.match(PILOT_ACTION_EFFECT.revoke, /404/, 'отзыв: новые сборки — 404');

  // ── Даты ──
  assert.equal(kyivDate('2026-10-20T09:00:00.000Z'), '20.10.2026, 12:00');
  assert.equal(kyivDate('not a date'), 'not a date');

  // ── Ошибки словами: та форма, которую реально отдаёт backend ──
  // `common/filters/http-exception.filter.ts`: `error.code` — класс HTTP
  // (`CONFLICT`…), машинный код тела исключения — `error.details.code`
  // (ST3-U-08). Ошибки строятся через настоящий `handle()` из ответа fetch.
  const envelope = (status: number, httpCode: string, message: string, machine?: string) =>
    new Response(
      JSON.stringify({
        success: false,
        error: { code: httpCode, message, ...(machine ? { details: { code: machine } } : {}) },
        meta: { timestamp: '2026-10-20T10:00:00.000Z', path: '/api/admin/story-tales/pilot', requestId: 'r1' },
      }),
      { status },
    );
  const failWith = async (res: Response, kind?: 'approve' | 'reject' | 'revoke'): Promise<[string, unknown]> => {
    globalThis.fetch = (async () => res) as typeof fetch;
    try {
      if (kind === 'revoke') await revokeStoryPilotMember('u', { requestId: rid });
      else if (kind === 'reject') await rejectStoryPilotApplication('a', { requestId: rid });
      else if (kind === 'approve') await approveStoryPilotApplication('a', { requestId: rid });
      else await getStoryPilot();
    } catch (e) {
      return [pilotErrorText(e, kind), e];
    }
    throw new Error('ожидался отказ');
  };
  {
    const [text, e] = await failWith(envelope(409, 'CONFLICT', 'Мест в пилоте нет (лимит 15)', 'STORY_PILOT_FULL'), 'approve');
    assert.ok(e instanceof ApiRequestError);
    assert.equal(e.code, 'CONFLICT', 'класс HTTP — в error.code');
    assert.equal(pilotErrorCode(e), 'STORY_PILOT_FULL', 'машинный код — из error.details.code');
    assert.match(text, /все места заняты.*STORY_PILOT_MAX_MEMBERS/);
    assert.ok(pilotErrorNeedsReload(e));
  }
  assert.match((await failWith(envelope(409, 'CONFLICT', 'Заявка уже рассмотрена', 'STORY_PILOT_DECIDED'), 'reject'))[0], /уже рассмотрена.*обновлён/);
  assert.match((await failWith(envelope(409, 'CONFLICT', 'x', 'STORY_PILOT_ALREADY_MEMBER'), 'approve'))[0], /повторно одобрить его нельзя/);
  assert.match((await failWith(envelope(409, 'CONFLICT', 'Доступ уже отозван', 'STORY_PILOT_REVOKED'), 'revoke'))[0], /уже отозван/);
  {
    const [text, e] = await failWith(envelope(409, 'CONFLICT', 'Этот requestId уже использован для другого действия'), 'approve');
    assert.match(text, /^Конфликт: Этот requestId/);
    assert.equal(pilotErrorNeedsReload(e), false);
  }
  assert.match((await failWith(envelope(404, 'NOT_FOUND', 'Участник не найден'), 'revoke'))[0], /Участник не найден/);
  assert.match((await failWith(envelope(404, 'NOT_FOUND', 'Заявка не найдена'), 'approve'))[0], /Заявка не найдена/);
  assert.match((await failWith(envelope(404, 'NOT_FOUND', 'Cannot GET'))) [0], /проход 3/, 'загрузка: backend без раздела пилота');
  assert.match((await failWith(envelope(401, 'UNAUTHORIZED', 'x')))[0], /Сессия/);
  assert.match((await failWith(envelope(403, 'FORBIDDEN', 'x')))[0], /прав оператора/);
  assert.match((await failWith(envelope(400, 'BAD_REQUEST', 'Укажите причину: от 3 до 500 символов'), 'approve'))[0], /Сервер отклонил запрос: Укажите причину/);
  assert.match((await failWith(envelope(503, 'SERVICE_UNAVAILABLE', 'x')))[0], /Ошибка сервера \(503\).*безопасен/);
  assert.match(pilotErrorText(new TypeError('Failed to fetch')), /Нет связи с сервером/);
  assert.equal(pilotErrorText('boom'), 'Действие не выполнено');
  // Старая форма (код прямо в error.code) тоже понимается.
  assert.equal(pilotErrorCode(new ApiRequestError('x', 409, 'STORY_PILOT_FULL')), 'STORY_PILOT_FULL');

  // ── Заявитель, статусы, причины по умолчанию = сервер, чек-лист ──
  assert.equal(pilotUserLabel({ shortId: 'bbbbbbbb', telegramUsername: 'mama_k' }), '@mama_k (bbbbbbbb)');
  assert.equal(pilotUserLabel({ shortId: 'bbbbbbbb' }), 'bbbbbbbb');
  assert.match(PILOT_APPLICATION_STATUS.expired, /90 дней/);
  assert.match(approveBlockedReason(overview(3), app('expired')) ?? '', /рассмотрена/, 'истёкшую заявку не одобрить');
  const service = path.join(__dirname, '..', '..', '..', 'backend', 'src', 'modules', 'story-gifts', 'story-pilot.service.ts');
  if (fs.existsSync(service)) {
    const src = fs.readFileSync(service, 'utf8');
    for (const [kind, action] of [['approve', 'pilot.approve'], ['reject', 'pilot.reject'], ['revoke', 'pilot.revoke']] as const) {
      const server = new RegExp(`'${action.replace('.', '\\.')}':\\s*'([^']+)'`).exec(src)?.[1];
      assert.equal(PILOT_DEFAULT_REASON[kind], server, `${kind}: подпись «Пусто — …» ≠ DEFAULT_REASON сервера`);
    }
  } else {
    console.log('story-pilot: backend рядом нет — сверка причин по умолчанию пропущена');
  }
  assert.equal(PILOT_OWNER_CHECKLIST.length, 6);
  for (const re of [/РНОКПП/, /налоговый статус/, /e-mail/, /STORY_RETENTION_PURGE_ENABLED/, /Gemini/, /Resemble/, /Soniox/, /VeryGoodFFmpeg/, /Уповноваженого/, /30 рабочих дней/]) {
    assert.ok(PILOT_OWNER_CHECKLIST.some((item) => re.test(item)), `чек-лист: нет ${re}`);
  }

  console.log('story-pilot: адреса и тела контракта, места, блокировка «Одобрить», режим, подтверждения, даты и ошибки словами');
}
void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
