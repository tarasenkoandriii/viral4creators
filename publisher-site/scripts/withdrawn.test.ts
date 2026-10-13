/**
 * Статус снятия для middleware (аудит P-F S2-2): fail-closed — сбой списка
 * НЕ кэшируется как «пусто», при неизвестном списке проверяется сам
 * материал, при неизвестном всём — `unknown` (middleware → 503, без текста).
 */
import assert from 'node:assert/strict';
import { LIST_RETRY_MS, resetWithdrawnState, slugState, TTL_MS, type Deps } from '../src/lib/withdrawn';

const API = 'https://api.example';
const SITE = 'https://site.example';
const O = { site: SITE, api: API };
const KEY = 'pp_standPublisherKey0000001';
let n = 0;
const eq = (a: unknown, b: unknown, m: string) => {
  n++;
  assert.deepEqual(a, b, m);
};
type Plan = { list: number | 'throw'; listBody?: unknown; slug: Record<string, number | 'throw'> };
function deps(plan: Plan, clock: { t: number }, calls: string[]): Deps {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  return {
    now: () => clock.t,
    fetch: async (url: string) => {
      calls.push(url.replace(API, '').replace(SITE, '').replace(/\?.*$/, ''));
      if (url.split('?')[0] === `${SITE}/api/withdrawn`) {
        if (plan.list === 'throw') throw new Error('ECONNRESET');
        return json(
          plan.list,
          plan.list === 200
            ? (plan.listBody ?? {
                success: true,
                data: [
                  { slug: 'gone-one', withdrawn: true },
                  { slug: 'live-one', withdrawn: false },
                ],
              })
            : { success: false },
        );
      }
      const slug = url.split('?')[0].split('/').pop()!;
      const st = plan.slug[slug] ?? 200;
      if (st === 'throw') throw new Error('timeout');
      return json(st, { success: st === 200 || st === 410 });
    },
  };
}

async function main() {
  // 1. Список получен: решает список, повтор в пределах TTL — без запросов.
  resetWithdrawnState();
  let clock = { t: 1_000_000 };
  let calls: string[] = [];
  let d = deps({ list: 200, slug: {} }, clock, calls);
  eq(await slugState(O, KEY, 'gone-one', d), 'withdrawn', 'снят по списку');
  eq(await slugState(O, KEY, 'live-one', d), 'pass', 'опубликован по списку');
  eq(calls.length, 1, 'список кэшируется');
  clock.t += TTL_MS - 1;
  await slugState(O, KEY, 'live-one', d);
  eq(calls.length, 1, 'в пределах 60 с — без запросов');

  // 2. Список истёк и не получен (500): НЕ «пусто» — проверка самого материала.
  clock.t += 2;
  const plan: Plan = { list: 500, slug: { 'gone-one': 410, 'live-one': 200, 'broken-one': 503, 'net-one': 'throw' } };
  d = deps(plan, clock, calls);
  eq(await slugState(O, KEY, 'gone-one', d), 'withdrawn', 'сбой списка: снятый по ответу 410 материала');
  eq(await slugState(O, KEY, 'live-one', d), 'pass', 'сбой списка: опубликованный по 200');
  eq(await slugState(O, KEY, 'broken-one', d), 'unknown', 'сбой списка и материала (503) — неизвестно → 503 сайта');
  eq(await slugState(O, KEY, 'net-one', d), 'unknown', 'сбой сети — неизвестно');
  eq(calls.filter((c) => c === '/api/withdrawn').length, 2, 'после сбоя список не перезапрашивается чаще 5 с');
  // Неизвестное не кэшируется: материал ожил — сразу pass.
  plan.slug['broken-one'] = 200;
  eq(await slugState(O, KEY, 'broken-one', d), 'pass', 'неизвестное не кэшируется');
  // Через 5 с список запрашивается снова.
  clock.t += LIST_RETRY_MS;
  plan.list = 200;
  eq(await slugState(O, KEY, 'gone-one', d), 'withdrawn', 'список восстановлен');
  eq(calls.filter((c) => c === '/api/withdrawn').length, 3, 'повтор списка через 5 с');

  // 3. Исключение и «не список» в теле — тоже сбой, а не пусто.
  for (const [name, p] of [
    ['throw', { list: 'throw', slug: { x: 410 } }],
    ['не список', { list: 200, listBody: { success: true, data: {} }, slug: { x: 410 } }],
    ['success:false', { list: 200, listBody: { success: false }, slug: { x: 410 } }],
  ] as const) {
    resetWithdrawnState();
    clock = { t: 5_000_000 };
    calls = [];
    eq(
      await slugState(O, KEY, 'xxx', deps({ ...(p as Plan), slug: { xxx: 410 } }, clock, calls)),
      'withdrawn',
      `список ${name} → проверка материала`,
    );
  }
  // 3б. Z-2b: список берётся у СВОЕГО маршрута сайта, не у API; снятие видно через ≤ 1 с (TTL памяти).
  resetWithdrawnState();
  clock = { t: 7_000_000 };
  calls = [];
  const live: Plan = { list: 200, listBody: { success: true, data: [] }, slug: {} };
  d = deps(live, clock, calls);
  eq(await slugState(O, KEY, 'fresh-one', d), 'pass', 'до снятия');
  eq(calls[0], '/api/withdrawn', 'источник списка — /api/withdrawn сайта (общий data cache)');
  live.listBody = { success: true, data: [{ slug: 'fresh-one', withdrawn: true }] }; // бэкенд снял + /api/revalidate
  eq(await slugState(O, KEY, 'fresh-one', d), 'pass', 'в пределах TTL памяти — прежний ответ');
  clock.t += TTL_MS;
  eq(await slugState(O, KEY, 'fresh-one', d), 'withdrawn', 'через TTL (1 с) — 410');
  eq(TTL_MS <= 1000, true, 'TTL памяти middleware ≤ 1 с');
  // 4. Результат проверки материала кэшируется на TTL.
  resetWithdrawnState();
  clock = { t: 9_000_000 };
  calls = [];
  d = deps({ list: 500, slug: { abc: 410 } }, clock, calls);
  await slugState(O, KEY, 'abc', d);
  clock.t += TTL_MS - 1;
  await slugState(O, KEY, 'abc', d);
  eq(calls.filter((c) => c.endsWith('/abc')).length, 1, 'итог материала кэшируется');
  console.log(
    `ok   withdrawn: ${n} проверок — fail-closed: сбой списка не «пусто», проверка материала, неизвестно → 503, повтор списка через 5 с, кэш ≤ 1 с, список — /api/withdrawn`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
