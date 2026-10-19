/**
 * Внутренний аудит 19.10.2026, IA-D1-03 (Р-IA-FXC-2): отложенный вызов
 * `pub.reddit.draft` оператора Админки (`admin:<userId>`) очередь
 * `ai-calls-run` исполняет, только если backend недавно подтвердил оператора
 * — есть строка журнала доступа Админки этого актора не старше
 * `ADMIN_ATTEST_MS` (каждый запрос оператора проходит `assertOperator` в
 * прокси backend и пишет строку в `AdminRedditGuard`). Исходный сценарий:
 * оператор запустил генерацию (> 25 с → очередь), владелец снял
 * `isOperator` — прокси перестаёт пересылать опросы, строк нет → `refused`
 * `PUB_ROLE_REQUIRED`, модель не вызывается, стоимость 0.
 */
import { randomUUID } from 'crypto';
import { ciDescribe } from '../../../../prisma/ci-describe.testing';
import { AiCallsRunJob } from '../../ai/ai-calls-run.job';
import { AiGatewayService } from '../../ai/ai-gateway.service';
import { ADMIN_ATTEST_MS, adminActorAttested } from '../../core/admin-attest';
import { adminApi, useAdminEnv } from '../testing/admin-kit.testing';
import {
  redditStack,
  redditWorld,
  type RedditStack,
  type RedditWorld,
} from '../testing/reddit-kit.testing';

jest.setTimeout(180_000);

ciDescribe('IA-D1-03: очередь AI — подтверждение оператора Админки', () => {
  let s: RedditStack;
  let w: RedditWorld;
  let restoreEnv: () => void;
  beforeAll(async () => {
    s = await redditStack();
    w = await redditWorld(s, 'working');
    // Сайт кабинета — платформенный: `recheckCall` принимает admin-актора.
    restoreEnv = useAdminEnv(w.acc.siteId);
  });
  afterAll(async () => {
    restoreEnv?.();
    await s?.close();
  });

  /** Вызов `pub.reddit.draft` в очереди: `running`, аренда истекла. */
  async function queuedAdminCall(actor: string): Promise<string> {
    const base = { accountId: w.acc.accountId, productId: w.product.id };
    const task = await s.prisma.pubAiTask.create({
      data: {
        ...base,
        generator: 'pub.reddit.draft',
        objectType: 'product',
        objectId: `${w.product.id}-${randomUUID().slice(0, 6)}`,
        generationsUsed: 1,
        createdBy: actor,
      },
    });
    const call = await s.prisma.pubAiCall.create({
      data: {
        ...base,
        taskId: task.id,
        attemptNo: 1,
        generator: 'pub.reddit.draft',
        purpose: 'draft',
        instructionVersion: 'pub.reddit.draft@1',
        contextRulesVersion: 'ctx@1',
        sourceIds: [],
        provider: 'fake',
        model: 'fake',
        opKey: randomUUID(),
        status: 'running',
        costStatus: 'unknown',
        requestedBy: actor,
        createdBy: actor,
      },
    });
    await s.prisma.$executeRawUnsafe(
      `UPDATE "sites"."pub_ai_calls" SET "updatedAt" = now() - interval '2 minutes' WHERE "id" = $1`,
      call.id,
    );
    return call.id;
  }

  const runJob = () =>
    s.mod.get(AiCallsRunJob).run({
      now: new Date(),
      scope: { siteIds: [w.acc.siteId] },
      deadline: new Date(Date.now() + 30_000),
    });

  const callRow = (id: string) =>
    s.prisma.pubAiCall.findUniqueOrThrow({
      where: { id },
      select: { status: true, errorCode: true, costMicroUsd: true },
    });

  it('оператора сняли (прокси backend больше не пересылает — строк журнала нет) → refused PUB_ROLE_REQUIRED, модель не вызвана, стоимость 0', async () => {
    const user = `clAttest${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const id = await queuedAdminCall(`admin:${user}`);
    const exec = jest.spyOn(s.mod.get(AiGatewayService), 'execute');
    try {
      const r = await runJob();
      expect(r.details).toMatchObject({ refused: 1, executed: 0 });
      expect(exec).not.toHaveBeenCalled();
    } finally {
      exec.mockRestore();
    }
    const row = await callRow(id);
    expect({
      status: row.status,
      errorCode: row.errorCode,
      cost: String(row.costMicroUsd),
    }).toEqual({
      status: 'refused',
      errorCode: 'PUB_ROLE_REQUIRED',
      cost: '0',
    });
  });

  it('строка журнала старше окна — не подтверждение: refused PUB_ROLE_REQUIRED', async () => {
    const user = `clAttest${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await s.prisma.pubRedditAdminAccessLog.create({
      data: {
        actor: `admin:${user}`,
        method: 'GET',
        route: 'status',
        status: 200,
        at: new Date(Date.now() - ADMIN_ATTEST_MS - 5_000),
      },
    });
    expect(await adminActorAttested(s.db, `admin:${user}`)).toBe(false);
    const id = await queuedAdminCall(`admin:${user}`);
    await runJob();
    expect((await callRow(id)).errorCode).toBe('PUB_ROLE_REQUIRED');
  });

  it('оператор действует (свежий запрос через внутренний API — строка журнала от гварда) → проверка прав пройдена, дальше обычный recheckCall', async () => {
    const user = `clAttest${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const A = adminApi(s, { actor: user });
    expect((await A.get('status')).status).toBe(200);
    expect(await adminActorAttested(s.db, `admin:${user}`)).toBe(true);
    const id = await queuedAdminCall(`admin:${user}`);
    await runJob();
    const row = await callRow(id);
    // Модель не привязана в этом мире — отказ гейта/конфигурации, но НЕ по
    // праву автора: подтверждение оператора пройдено.
    expect(row.status).toBe('refused');
    expect(row.errorCode).not.toBe('PUB_ROLE_REQUIRED');
    expect(row.errorCode).toMatch(/^PUB_(AI_NOT_EVALUATED|GATE_CLOSED)/);
  });

  it('участник кабинета (member:) журналом Админки не проверяется — его право перепроверяет recheckCall (D2-03)', async () => {
    expect(
      await adminActorAttested(s.db, `member:${w.team.editor.memberId}`),
    ).toBe(true);
  });
});
