/**
 * Порты ядра на базе (P-A1, проектный документ §16.0) — как их берут
 * пакеты этапа 1 через `PubPorts`:
 *  - `ParameterPort.decide` (P-B1: активация оффера обновляет
 *    `offer_active_version` решением): решение → параметр → флаги, версия
 *    растёт, человек обязателен;
 *  - `ReviewPort.open` — без дублей по событию;
 *  - `GatePort.assertOpen` — 409 `PUB_GATE_CLOSED {gate, missing}`;
 *  - `pii-guard` ≡ SQL `pub_looks_contact` на одних векторах.
 */
import { ciDescribe } from '../../../prisma/ci-describe.testing';
import {
  seedAccount,
  seedProduct,
  type SeededAccount,
} from '../testing/fixtures.testing';
import { PII_VECTORS } from '../testing/pii-vectors.testing';
import { looksLikeContact } from './pii-guard';
import { PubPorts, type PubTx } from './ports';
import type { Actor } from './state-machines';
import { coreStack, type CoreStack } from './testing/core-stack.testing';

jest.setTimeout(60_000);

const PO: Actor[] = ['product_owner'];

ciDescribe('Publisher P-A1: порты ядра на базе', () => {
  let s: CoreStack;
  let acc: SeededAccount;
  let ports: PubPorts;

  beforeAll(async () => {
    s = await coreStack();
    ports = s.mod.get(PubPorts);
    acc = await seedAccount(s.prisma);
  });
  afterAll(async () => {
    await s.close();
  });

  const inTx = <T>(fn: (tx: PubTx) => Promise<T>): Promise<T> =>
    s.db.forAccount(acc.accountId).$transaction(fn);

  it('ParameterPort.decide: значение без предложения (активация оффера), версия +1, затем смена значения approved→approved', async () => {
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'test',
    });
    const port = ports.parameters();
    const member = `member:${acc.owner.memberId}`;
    const r1 = await inTx<{ decisionId: string | null; version: number }>(
      (tx) =>
        port.decide(tx, p, {
          key: 'offer_active_version',
          toStatus: 'approved',
          value: { offerVersionId: 'ov-1', version: 1 },
          basis: 'Активовано версію оферу 1',
          decidedBy: member,
          actors: PO,
        }),
    );
    expect(r1.version).toBe(2);
    const r2 = await inTx<{ decisionId: string | null; version: number }>(
      (tx) =>
        port.decide(tx, p, {
          key: 'offer_active_version',
          toStatus: 'approved',
          value: { offerVersionId: 'ov-2', version: 2 },
          basis: 'Активовано версію оферу 2',
          decidedBy: member,
          actors: PO,
        }),
    );
    expect(r2.version).toBe(3);
    const cur = await inTx<{ value: unknown; status: string; version: number }>(
      (tx) => port.current(tx, p, 'offer_active_version'),
    );
    expect(cur).toEqual({
      key: 'offer_active_version',
      value: { offerVersionId: 'ov-2', version: 2 },
      status: 'approved',
      version: 3,
    });
    const log = await s.prisma.pubParameterDecision.findMany({
      where: { productId: p.id, parameterKey: 'offer_active_version' },
      orderBy: { version: 'asc' },
    });
    expect(log.map((d) => [d.version, d.fromStatus, d.toStatus])).toEqual([
      [2, 'assumption', 'approved'],
      [3, 'approved', 'approved'],
    ]);
    // повтор того же значения — не решение
    await expect(
      inTx((tx) =>
        port.decide(tx, p, {
          key: 'offer_active_version',
          toStatus: 'approved',
          value: { offerVersionId: 'ov-2', version: 2 },
          basis: 'Ще раз те саме',
          decidedBy: member,
          actors: PO,
        }),
      ),
    ).rejects.toMatchObject({ code: 'PUB_VALIDATION' });
    // решает только человек
    await expect(
      inTx((tx) =>
        port.decide(tx, p, {
          key: 'niche',
          toStatus: 'approved',
          basis: 'Системне рішення',
          decidedBy: 'system:x',
          actors: PO,
        }),
      ),
    ).rejects.toThrow(/решает человек/);
  });

  it('ParameterPort.decide: revoked закрывает гейт, решение из rejected — снова approved', async () => {
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'test',
    });
    const port = ports.parameters();
    const member = `member:${acc.owner.memberId}`;
    await inTx((tx) =>
      port.decide(tx, p, {
        key: 'niche',
        toStatus: 'approved',
        basis: 'Ніша: освіта',
        decidedBy: member,
        actors: PO,
      }),
    );
    await inTx((tx) =>
      port.decide(tx, p, {
        key: 'niche',
        toStatus: 'revoked',
        basis: 'Ніша змінюється',
        decidedBy: member,
        actors: PO,
      }),
    );
    await expect(
      inTx((tx) =>
        port.decide(tx, p, {
          key: 'niche',
          toStatus: 'revoked',
          basis: 'Ще раз відкликати',
          decidedBy: member,
          actors: PO,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'PUB_TRANSITION_INVALID',
      details: { from: 'revoked', allowed: ['approved', 'assumption'] },
    });
    const g = await inTx<{ open: boolean; missing: unknown[] }>((tx) =>
      ports.gates().evaluate(tx, p, 'public_publish', new Date()),
    );
    expect(g.missing).toContainEqual({
      kind: 'parameter',
      key: 'niche',
      detail: 'revoked',
    });
    await expect(
      inTx((tx) =>
        ports.gates().assertOpen(tx, p, 'public_publish', new Date()),
      ),
    ).rejects.toMatchObject({
      code: 'PUB_GATE_CLOSED',
      details: { gate: 'public_publish' },
    });
  });

  it('ReviewPort.open: повтор события не плодит задач; объект/причина вне списка — ошибка кода', async () => {
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'test',
    });
    const item = {
      objectType: 'content' as const,
      objectId: 'c-1',
      reason: 'fact_changed' as const,
      triggerRef: 'fact:f1:v2',
      severity: 'critical' as const,
    };
    expect(
      await inTx<number>((tx) => ports.review().open(tx, p, [item, item])),
    ).toBe(1);
    expect(await inTx<number>((tx) => ports.review().open(tx, p, [item]))).toBe(
      0,
    );
    expect(
      await inTx<number>((tx) =>
        ports.review().open(tx, p, [{ ...item, triggerRef: 'fact:f1:v3' }]),
      ),
    ).toBe(1);
    await expect(
      inTx((tx) =>
        ports.review().open(tx, p, [{ ...item, reason: 'nope' as never }]),
      ),
    ).rejects.toThrow(/вне списка/);
    const audit = await s.prisma.pubAuditEvent.count({
      where: { productId: p.id, objectType: 'review_task', action: 'create' },
    });
    expect(audit).toBe(2);
  });

  it('ParameterPort.decide: роли решающего обязательны (аудит P3-5); assumption — допущение для test (контракт P-A0)', async () => {
    const p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      kind: 'test',
    });
    const port = ports.parameters();
    const member = `member:${acc.owner.memberId}`;
    const base = {
      key: 'form_limit' as const,
      basis: 'Ліміт форми для тестового сайту',
      decidedBy: member,
    };
    await expect(
      inTx((tx) =>
        port.decide(tx, p, {
          ...base,
          toStatus: 'approved',
          actors: undefined as unknown as Actor[],
        }),
      ),
    ).rejects.toThrow(/actors/);
    // редактор не решает по параметрам — машина отказывает
    await expect(
      inTx((tx) =>
        port.decide(tx, p, {
          ...base,
          toStatus: 'approved',
          actors: ['editor'],
        }),
      ),
    ).rejects.toMatchObject({ code: 'PUB_ROLE_REQUIRED' });
    const r = await inTx((tx) =>
      port.decide(tx, p, { ...base, toStatus: 'assumption', actors: PO }),
    );
    expect(r.version).toBe(2);
    const row = await s.prisma.pubParameter.findFirst({
      where: { productId: p.id, key: 'form_limit' },
    });
    expect([row?.status, row?.version]).toEqual(['assumption', 2]);
    // то же допущение повторно — не решение
    await expect(
      inTx((tx) =>
        port.decide(tx, p, { ...base, toStatus: 'assumption', actors: PO }),
      ),
    ).rejects.toMatchObject({ code: 'PUB_VALIDATION' });
    // approved → assumption нельзя (понижение — только revoked)
    await inTx((tx) =>
      port.decide(tx, p, { ...base, toStatus: 'approved', actors: PO }),
    );
    await expect(
      inTx((tx) =>
        port.decide(tx, p, {
          ...base,
          toStatus: 'assumption',
          value: { count: 3, windowSec: 3600 },
          actors: PO,
        }),
      ),
    ).rejects.toMatchObject({ code: 'PUB_TRANSITION_INVALID' });
  });

  it('pii-guard ≡ SQL pub_looks_contact: общая таблица векторов (аудит P2-2/P2-3)', async () => {
    const vectors = PII_VECTORS.map(([v]) => v);
    const rows = await s.prisma.$queryRawUnsafe<
      Array<{ v: string; c: boolean }>
    >(
      `SELECT v, "sites"."pub_looks_contact"(v) AS c
         FROM unnest($1::text[]) WITH ORDINALITY AS t(v, o) ORDER BY o`,
      vectors,
    );
    expect(rows.map((r) => [r.v, r.c])).toEqual(PII_VECTORS);
    expect(rows.map((r) => [r.v, r.c])).toEqual(
      vectors.map((v) => [v, looksLikeContact(v)]),
    );
  });
});
