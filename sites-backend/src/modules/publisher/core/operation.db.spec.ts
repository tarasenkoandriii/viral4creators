/**
 * `runOperation` на базе (P-A1, проектный документ §8.1; механизм
 * AT-CORE-10): идемпотентность по `opKey` уровня кабинета, повтор → прежний
 * ответ без выполнения, другое тело/объект → 409, откат не сохраняет ключ,
 * `storeResponse:false`, ключи ПД в ответе, CAS → 409, отказ триггера →
 * PUB_VALIDATION, раскрытие-чтение без ключа идемпотентности.
 */
import { randomUUID } from 'crypto';
import { ciDescribe } from '../../../prisma/ci-describe.testing';
import {
  seedMembers,
  seedTwoAccounts,
  type TwoAccounts,
} from '../testing/fixtures.testing';
import { PubError } from './errors';
import { PubOperations, mapDbError, type OperationCtx } from './operation';
import { casUpdate } from './revision';
import { accessOf } from './roles';
import { coreStack, type CoreStack } from './testing/core-stack.testing';

jest.setTimeout(60_000);

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof PubError
      ? { code: e.code, details: e.details }
      : { error: String(e) };
  }
  return { ok: true };
};

ciDescribe('Publisher P-A1: runOperation на базе', () => {
  let s: CoreStack;
  let w: TwoAccounts;
  let ops: PubOperations;

  beforeAll(async () => {
    s = await coreStack();
    ops = s.mod.get(PubOperations);
    w = await seedTwoAccounts(s.prisma, { withProducts: true });
  });
  afterAll(async () => {
    await s.close();
  });

  const ctxOf = (
    over: Partial<OperationCtx<unknown>> = {},
  ): OperationCtx<unknown> => {
    const m = w.a.owner.membership;
    return {
      m,
      access: accessOf({
        memberId: m.memberId,
        grants: [],
        admin: true,
        accountOwner: true,
      }),
      product: w.a.product!,
      action: 'product.update',
      opKey: randomUUID(),
      scope: 'test.op',
      pathParams: { pid: w.a.product!.id },
      body: { x: 1 },
      ...over,
    };
  };

  const keyRow = (opKey: string) =>
    s.prisma.pubIdempotencyKey.findFirst({
      where: { accountId: w.a.accountId, opKey },
    });

  it('первый вызов выполняет fn и пишет ключ с ответом; повтор с тем же телом — прежний ответ без выполнения', async () => {
    const ctx = ctxOf();
    let calls = 0;
    const fn = async () => {
      calls++;
      return { status: 201, body: { n: calls, big: 10n }, audit: [] };
    };
    const first = await ops.run(ctx, fn);
    expect(first).toEqual({
      status: 201,
      body: { n: 1, big: '10' },
      replayed: false,
    });
    const again = await ops.run({ ...ctx, body: { x: 1 } }, fn);
    expect(again).toEqual({
      status: 201,
      body: { n: 1, big: '10' },
      replayed: true,
    });
    expect(calls).toBe(1);
    const row = await keyRow(ctx.opKey as string);
    expect(row).toMatchObject({
      responseStatus: 201,
      scope: 'test.op',
      productId: w.a.product!.id,
    });
    expect(row!.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 29 * 24 * 3600_000,
    );
  });

  it('тот же opKey с другим телом или на другом объекте — 409 PUB_IDEMPOTENCY_REUSED', async () => {
    const ctx = ctxOf();
    await ops.run(ctx, async () => ({
      status: 200,
      body: { ok: 1 },
      audit: [],
    }));
    expect(
      await code(
        ops.run({ ...ctx, body: { x: 2 } }, async () => ({
          status: 200,
          body: {},
          audit: [],
        })),
      ),
    ).toEqual({
      code: 'PUB_IDEMPOTENCY_REUSED',
      details: {},
    });
    expect(
      (
        await code(
          ops.run({ ...ctx, pathParams: { pid: 'other' } }, async () => ({
            status: 200,
            body: {},
            audit: [],
          })),
        )
      ).code,
    ).toBe('PUB_IDEMPOTENCY_REUSED');
    // аудит P3-13: тот же путь и тело, другой scope — 409
    expect(
      (
        await code(
          ops.run({ ...ctx, scope: 'test.other' }, async () => ({
            status: 200,
            body: {},
            audit: [],
          })),
        )
      ).code,
    ).toBe('PUB_IDEMPOTENCY_REUSED');
  });

  it('аудит P3-2: тот же opKey и тело от ДРУГОГО участника кабинета — 409, а не чужой ответ', async () => {
    const ctx = ctxOf();
    await ops.run(ctx, async () => ({
      status: 200,
      body: { ownerOnlyA: 1 },
      audit: [],
    }));
    const team = await seedMembers(s.prisma, w.a.product!, w.a.owner);
    const m = team.admin.membership;
    const other = {
      ...ctx,
      m,
      access: accessOf({
        memberId: m.memberId,
        grants: [],
        admin: true,
        accountOwner: false,
      }),
    };
    expect(
      await code(
        ops.run(other, async () => ({ status: 200, body: {}, audit: [] })),
      ),
    ).toEqual({ code: 'PUB_IDEMPOTENCY_REUSED', details: {} });
  });

  it('ключ уровня кабинета: тот же opKey в другом кабинете — независимая операция', async () => {
    const opKey = randomUUID();
    await ops.run(ctxOf({ opKey }), async () => ({
      status: 200,
      body: { a: 1 },
      audit: [],
    }));
    const mb = w.b.owner.membership;
    const r = await ops.run(
      {
        ...ctxOf({ opKey }),
        m: mb,
        access: accessOf({
          memberId: mb.memberId,
          grants: [],
          admin: true,
          accountOwner: true,
        }),
        product: w.b.product!,
      },
      async () => ({ status: 200, body: { b: 1 }, audit: [] }),
    );
    expect(r).toEqual({ status: 200, body: { b: 1 }, replayed: false });
  });

  it('ошибка внутри — откат: ключа нет, повтор выполняет операцию заново', async () => {
    const ctx = ctxOf();
    await expect(
      ops.run(ctx, async (tx) => {
        await tx.pubAuditEvent.create({
          data: {
            accountId: w.a.accountId,
            productId: w.a.product!.id,
            actor: 'system:test',
            objectType: 'product',
            objectId: 'x',
            action: 'update',
            createdBy: 'system:test',
          },
        });
        throw new PubError('PUB_CONFLICT', { currentRevision: 7 });
      }),
    ).rejects.toMatchObject({ code: 'PUB_CONFLICT' });
    expect(await keyRow(ctx.opKey as string)).toBeNull();
    const r = await ops.run(ctx, async () => ({
      status: 200,
      body: { retried: true },
      audit: [],
    }));
    expect(r.replayed).toBe(false);
  });

  it('аудит операции пишется в той же транзакции (актёр — участник)', async () => {
    const ctx = ctxOf();
    const objectId = `obj-${randomUUID()}`;
    await ops.run(ctx, async () => ({
      status: 200,
      body: {},
      audit: [
        {
          objectType: 'product',
          objectId,
          action: 'update',
          meta: { field: 'name' },
        },
      ],
    }));
    const ev = await s.prisma.pubAuditEvent.findFirst({ where: { objectId } });
    expect(ev).toMatchObject({
      actor: `member:${w.a.owner.memberId}`,
      action: 'update',
      productId: w.a.product!.id,
    });
  });

  it('storeResponse:false — в ключе только hash ответа; повтор пересобирает ответ', async () => {
    let rebuilt = 0;
    const ctx = ctxOf({
      storeResponse: false,
      rebuild: async () => {
        rebuilt++;
        return { fresh: true };
      },
    });
    await ops.run(ctx, async () => ({
      status: 200,
      body: { secretish: 'x' },
      audit: [],
    }));
    const row = await keyRow(ctx.opKey as string);
    expect(Object.keys(row!.responseBody as object)).toEqual(['responseHash']);
    const again = await ops.run(ctx, async () => ({
      status: 200,
      body: {},
      audit: [],
    }));
    expect(again).toEqual({
      status: 200,
      body: { fresh: true },
      replayed: true,
    });
    expect(rebuilt).toBe(1);
  });

  it('ответ с ключами ПД (contact/name/task/*Enc) — отказ и откат (раскрытие — только чтение)', async () => {
    const ctx = ctxOf();
    await expect(
      ops.run(ctx, async () => ({
        status: 200,
        body: { lead: { contact: 'a@b.c' } },
        audit: [],
      })),
    ).rejects.toThrow(/ключи персональных данных/);
    expect(await keyRow(ctx.opKey as string)).toBeNull();
  });

  it('Р-PUB-Z2-5: displayName в сохраняемом ответе — отказ кода и триггера; memberDisplayName (снимок имени в ролях) — разрешён', async () => {
    const bad = ctxOf();
    await expect(
      ops.run(bad, async () => ({
        status: 200,
        body: { owner: { displayName: 'Олена' } },
        audit: [],
      })),
    ).rejects.toThrow(/ключи персональных данных \(displayName\)/);
    expect(await keyRow(bad.opKey as string)).toBeNull();
    const ok = ctxOf();
    await ops.run(ok, async () => ({
      status: 200,
      body: { memberDisplayName: 'Учасник …abc' },
      audit: [],
    }));
    expect((await keyRow(ok.opKey as string))?.responseBody).toEqual({
      memberDisplayName: 'Учасник …abc',
    });
    // Триггер `pub_idempotency_guard` — та же нормализация (вторая линия).
    for (const k of ['displayName', 'display_name', 'DisplayName']) {
      await expect(
        s.prisma.$executeRawUnsafe(
          `UPDATE "sites"."pub_idempotency_keys" SET "responseBody" = $1::jsonb
            WHERE "accountId" = $2 AND "opKey" = $3`,
          JSON.stringify({ a: [{ [k]: 'x' }] }),
          w.a.accountId,
          ok.opKey,
        ),
      ).rejects.toThrow(/ключи персональных данных запрещены/);
    }
  });

  it('Р-PUB-Z2-2: действие, запрещённое для вида продукта (раскрытие в restored), — 403 и в операции, и в чтении с аудитом', async () => {
    const restored = { ...w.a.product!, kind: 'restored' as const };
    const ctx = ctxOf({ product: restored, action: 'lead.contact.reveal' });
    expect(
      await code(
        ops.run(ctx, async () => ({ status: 200, body: {}, audit: [] })),
      ),
    ).toEqual({
      code: 'PUB_ROLE_REQUIRED',
      details: {
        action: 'lead.contact.reveal',
        reason: 'product_kind',
        kind: 'restored',
      },
    });
    expect(
      await code(
        ops.recordRead(ctx.m, ctx.access, restored, 'lead.contact.reveal', {
          objectType: 'lead',
          objectId: 'x',
          action: 'reveal_contact',
          meta: { what: 'contact' },
        }),
      ),
    ).toMatchObject({
      code: 'PUB_ROLE_REQUIRED',
      details: { reason: 'product_kind' },
    });
  });

  it('роль не по матрице — 403 PUB_ROLE_REQUIRED до транзакции; кривой opKey — 400', async () => {
    const m = w.a.owner.membership;
    const viewer = accessOf({
      memberId: m.memberId,
      grants: ['viewer'],
      admin: false,
      accountOwner: false,
    });
    expect(
      (
        await code(
          ops.run(ctxOf({ access: viewer }), async () => ({
            status: 200,
            body: {},
            audit: [],
          })),
        )
      ).code,
    ).toBe('PUB_ROLE_REQUIRED');
    expect(
      (
        await code(
          ops.run(ctxOf({ opKey: 'nope' }), async () => ({
            status: 200,
            body: {},
            audit: [],
          })),
        )
      ).code,
    ).toBe('PUB_VALIDATION');
    expect(
      (
        await code(
          ops.run(ctxOf({ opKey: randomUUID().toUpperCase() }), async () => ({
            status: 200,
            body: {},
            audit: [],
          })),
        )
      ).code,
    ).toBe('PUB_VALIDATION');
  });

  it('CAS: устаревшая ревизия — 409 PUB_CONFLICT с текущей; чужой продукт — 404', async () => {
    const p = w.a.product!;
    const r1 = await ops.run(ctxOf(), async (tx) => {
      const cur = await tx.pubProduct.findFirst({
        where: { id: p.id },
        select: { revision: true },
      });
      const next = await casUpdate(tx.pubProduct, p.id, cur!.revision, {
        name: 'Перейменовано',
      });
      return { status: 200, body: { next }, audit: [] };
    });
    const next = (r1.body as { next: number }).next;
    expect(
      await code(
        ops.run(ctxOf(), async (tx) => {
          await casUpdate(tx.pubProduct, p.id, next - 1, {
            name: 'Стара ревізія',
          });
          return { status: 200, body: {}, audit: [] };
        }),
      ),
    ).toEqual({ code: 'PUB_CONFLICT', details: { currentRevision: next } });
    expect(
      (
        await code(
          ops.run(ctxOf(), async (tx) => {
            await casUpdate(tx.pubProduct, w.b.product!.id, 1, {
              name: 'Чужий',
            });
            return { status: 200, body: {}, audit: [] };
          }),
        )
      ).code,
    ).toBe('PUB_NOT_FOUND');
  });

  it('параллельные запросы с одним opKey — fn выполнена ровно один раз', async () => {
    const ctx = ctxOf();
    let calls = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        ops.run({ ...ctx }, async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 50));
          return { status: 201, body: { id: 'one' }, audit: [] };
        }),
      ),
    );
    expect(calls).toBe(1);
    const outcomes = results.map((r) =>
      r.status === 'fulfilled'
        ? JSON.stringify(r.value.body)
        : (r.reason as PubError).code,
    );
    expect(
      outcomes.filter((o) => o !== '{"id":"one"}' && o !== 'PUB_BUSY'),
    ).toEqual([]);
    expect(
      outcomes.filter((o) => o === '{"id":"one"}').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('отказ триггера (23514) → PUB_VALIDATION с полем «таблица.поле»', async () => {
    const e = await code(
      ops.run(ctxOf(), async (tx) => {
        await tx.pubProduct.updateMany({
          where: { id: w.a.product!.id },
          data: { mode: 'banana' },
        });
        return { status: 200, body: {}, audit: [] };
      }),
    );
    expect(e).toEqual({
      code: 'PUB_VALIDATION',
      details: { fields: [{ field: 'pub_products.mode', code: 'constraint' }] },
    });
  });

  it('mapDbError: P2028 → PUB_BUSY, 23505 → PUB_CONFLICT, чужие ошибки — null', () => {
    expect(mapDbError({ code: 'P2028' })?.code).toBe('PUB_BUSY');
    expect(mapDbError({ cause: { originalCode: '23505' } })?.code).toBe(
      'PUB_CONFLICT',
    );
    expect(mapDbError(new Error('x'))).toBeNull();
  });

  it('аудит чтения (раскрытие контакта) — без ключа идемпотентности, отдельной транзакцией', async () => {
    const before = await s.prisma.pubIdempotencyKey.count({
      where: { accountId: w.a.accountId },
    });
    const objectId = `lead-${randomUUID()}`;
    const m = w.a.owner.membership;
    await ops.recordRead(
      m,
      accessOf({
        memberId: m.memberId,
        grants: [],
        admin: true,
        accountOwner: true,
      }),
      w.a.product!,
      'lead.contact.reveal',
      {
        objectType: 'lead',
        objectId,
        action: 'reveal_contact',
        meta: { purpose: 'call' },
      },
    );
    expect(
      await s.prisma.pubIdempotencyKey.count({
        where: { accountId: w.a.accountId },
      }),
    ).toBe(before);
    expect(
      await s.prisma.pubAuditEvent.count({
        where: { objectId, action: 'reveal_contact' },
      }),
    ).toBe(1);
    // аналитик контакт не раскрывает (матрица §4.2)
    const an = accessOf({
      memberId: m.memberId,
      grants: ['analyst'],
      admin: false,
      accountOwner: false,
    });
    expect(
      (
        await code(
          ops.recordRead(m, an, w.a.product!, 'lead.contact.reveal', {
            objectType: 'lead',
            objectId,
            action: 'reveal_contact',
          }),
        )
      ).code,
    ).toBe('PUB_ROLE_REQUIRED');
  });

  it('аудит: контакт в reason — 400 pii; ключ ПД в meta — ошибка кода', async () => {
    expect(
      await code(
        ops.run(ctxOf(), async () => ({
          status: 200,
          body: {},
          audit: [
            {
              objectType: 'product',
              objectId: 'x',
              action: 'update',
              reason: 'дзвонив +380 67 123 45 67',
            },
          ],
        })),
      ),
    ).toEqual({
      code: 'PUB_VALIDATION',
      details: { fields: [{ field: 'reason', code: 'pii' }] },
    });
    await expect(
      ops.run(ctxOf(), async () => ({
        status: 200,
        body: {},
        audit: [
          {
            objectType: 'product',
            objectId: 'x',
            action: 'update',
            meta: { nested: [{ Email: 'x' }] },
          },
        ],
      })),
    ).rejects.toThrow(/meta ключи персональных данных/);
  });
});
