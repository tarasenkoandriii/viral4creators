/**
 * Матрица операций §4.2 (P-A1; AT-CORE-11 — права; основа AT-CORE-08 —
 * маршрут вне матрицы роняет тест):
 *  - строки матрицы дословно (выборочно ключевые запреты ТЗ §5);
 *  - TD-02: разрешённые действия каждой роли;
 *  - КАЖДЫЙ маршрут `/publisher/*` собранного AppModule несёт
 *    `@PubAllow(...)` с действиями из матрицы, `@AllowApps('assist')` и
 *    `REQUIRE_PUBLISHER_ANY`; публичные маршруты Publisher — только
 *    `/public/publisher/v1/*` и кроны.
 */
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../../app.module';
import { REQUIRE_PUBLISHER_ANY } from '../../site-core/account/roles';
import { PUB_ROLES } from '../contracts/states';
import { TD02_KEYS, td02Allowed } from '../testing/fixtures.testing';
import {
  enumerateRoutes,
  isolationTargets,
  publisherCabinetRoutes,
  type RouteInfo,
} from './route-enumerator';
import {
  PUB_ACTIONS,
  PUB_PERMISSIONS,
  accessOf,
  allowedActions,
  can,
  deniedForKind,
  isPubAction,
  isSelfReview,
  myRolesOf,
  type PubAction,
} from './roles';

jest.setTimeout(60_000);

const acc = (
  grants: string[] = [],
  o: { admin?: boolean; owner?: boolean } = {},
) =>
  accessOf({
    memberId: 'm1',
    grants: grants as never,
    admin: !!o.admin,
    accountOwner: !!o.owner,
  });

describe('roles: матрица §4.2', () => {
  it('ключевые строки ТЗ §5', () => {
    // контакт видят только SA и PO (и владелец кабинета); админ — нет (Р-PUB-19)
    expect(can(acc(['sales']), 'lead.contact.reveal')).toBe(true);
    expect(can(acc(['product_owner']), 'lead.contact.reveal')).toBe(true);
    expect(can(acc(['analyst']), 'lead.contact.reveal')).toBe(false);
    expect(can(acc([], { admin: true }), 'lead.contact.reveal')).toBe(false);
    expect(can(acc([], { owner: true }), 'lead.contact.reveal')).toBe(true);
    // согласование версии и закупки — только PO
    for (const r of PUB_ROLES.filter((x) => x !== 'product_owner')) {
      expect(can(acc([r]), 'version.approve')).toBe(false);
      expect(can(acc([r]), 'placement.approve')).toBe(false);
      expect(can(acc([r]), 'parameter.decide')).toBe(false);
    }
    // роли, режим, бэкап — только admin; восстановление apply — только владелец кабинета
    expect(can(acc(['product_owner']), 'role.manage')).toBe(false);
    expect(can(acc([], { admin: true }), 'role.manage')).toBe(true);
    expect(can(acc([], { admin: true }), 'restore.apply')).toBe(false);
    expect(can(acc([], { owner: true }), 'restore.apply')).toBe(true);
    // оператор — техническая проверка да, редакционная нет
    expect(can(acc(['operator']), 'qa.technical')).toBe(true);
    expect(can(acc(['operator']), 'qa.editorial')).toBe(false);
    // viewer — только чтение
    expect(allowedActions(acc(['viewer']))).toEqual([
      'product.read',
      'site.product.read',
    ]);
    // AI: оператор — только helper
    expect(can(acc(['operator']), 'ai.helper')).toBe(true);
    expect(can(acc(['operator']), 'ai.generate')).toBe(false);
  });

  it('владелец кабинета — все роли продукта (включая sales) и admin', () => {
    const owner = acc([], { owner: true });
    expect(myRolesOf(owner)).toEqual({
      roles: [...PUB_ROLES],
      admin: true,
      accountOwner: true,
    });
    expect(PUB_ACTIONS.every((a) => can(owner, a))).toBe(true);
  });

  it('самоаудит «(с)»: только у действий с пометкой и только при авторстве', () => {
    const po = acc(['product_owner']);
    expect(isSelfReview(po, 'version.approve', 'm1')).toBe(true);
    expect(isSelfReview(po, 'version.approve', 'm2')).toBe(false);
    expect(isSelfReview(po, 'product.update', 'm1')).toBe(false);
    expect(isSelfReview(po, 'placement.approve', null)).toBe(false);
  });

  it('TD-02: у каждой роли — ожидаемые разрешения и запреты', () => {
    const allowed = Object.fromEntries(
      TD02_KEYS.map((k) => [k, td02Allowed(k)]),
    );
    expect(allowed.noAccess).toEqual([]);
    expect(allowed.memberNoRoles).toEqual([]);
    expect(allowed.accountOwner).toEqual(PUB_ACTIONS);
    expect(allowed.admin).toEqual(
      expect.arrayContaining([
        'product.create',
        'role.manage',
        'product.mode',
        'backup.manage',
        'audit.read',
      ]),
    );
    expect(allowed.admin).not.toContain('lead.read');
    expect(allowed.sales).toEqual(
      expect.arrayContaining([
        'lead.contact.reveal',
        'payment.manage',
        'review.retention',
      ]),
    );
    expect(allowed.sales).not.toContain('version.manage');
    expect(allowed.analyst).toEqual(
      expect.arrayContaining([
        'parameter.propose',
        'report.manage',
        'audit.read',
      ]),
    );
    expect(allowed.analyst).not.toContain('parameter.decide');
    expect(allowed.editor).not.toContain('version.approve');
    expect(allowed.operator).toEqual(
      expect.arrayContaining(['budget.operate', 'publication.manage']),
    );
  });

  it('Р-PUB-Z2-2: раскрытие контакта запрещено в restored всем (и владельцу), в остальных видах — по ролям', () => {
    expect(deniedForKind('lead.contact.reveal', 'restored')).toBe(true);
    for (const k of ['working', 'test', 'eval'] as const)
      expect(deniedForKind('lead.contact.reveal', k)).toBe(false);
    expect(deniedForKind('lead.contact.reveal', null)).toBe(false);
    // Других запретов по виду пока нет.
    expect(PUB_ACTIONS.filter((a) => deniedForKind(a, 'restored'))).toEqual([
      'lead.contact.reveal',
    ]);
  });

  it('isPubAction — только ключи матрицы', () => {
    expect(isPubAction('product.read')).toBe(true);
    expect(isPubAction('toString')).toBe(false);
    expect(isPubAction('lead.delete')).toBe(false);
  });
});

describe('roles: матрица ↔ декораторы маршрутов собранного приложения', () => {
  let routes: RouteInfo[] = [];

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    routes = enumerateRoutes(ref.get(ModulesContainer));
    await ref.close();
  });

  it('у каждого маршрута /publisher/* — @PubAllow из матрицы, assist, REQUIRE_PUBLISHER_ANY', () => {
    const cabinet = publisherCabinetRoutes(routes);
    expect(cabinet.length).toBeGreaterThanOrEqual(19);
    const bad = cabinet
      .filter(
        (r) =>
          !r.pubActions ||
          r.pubActions.length === 0 ||
          !r.pubActions.every((a: PubAction) => isPubAction(a)) ||
          JSON.stringify(r.allowApps) !== JSON.stringify(['assist']) ||
          JSON.stringify(r.productRoles) !==
            JSON.stringify(REQUIRE_PUBLISHER_ANY) ||
          r.publicReason !== undefined ||
          !(r.params.includes('pid') || r.params.includes('siteId')),
      )
      .map((r) => `${r.method} ${r.path}`);
    expect(bad).toEqual([]);
  });

  it('маршруты уровня сайта — только действия siteLevel; у :pid — нет siteLevel', () => {
    for (const r of publisherCabinetRoutes(routes)) {
      const site = r.params.includes('siteId');
      const levels = (r.pubActions ?? []).map(
        (a) =>
          (PUB_PERMISSIONS[a] as { siteLevel?: boolean }).siteLevel === true,
      );
      expect({
        route: `${r.method} ${r.path}`,
        siteLevel: levels.every((x) => x === site),
      }).toEqual({
        route: `${r.method} ${r.path}`,
        siteLevel: true,
      });
    }
  });

  it('публичные маршруты Publisher — только /public/publisher/v1/* и три крона (minute — очередь AI, аудит P-B2 S2-1)', () => {
    const pub = routes
      .filter((r) => r.publicReason !== undefined && /publisher/.test(r.path))
      .map((r) => r.path);
    expect(
      pub.filter(
        (p) =>
          !/^\/public\/publisher\/v1\//.test(p) &&
          !/^\/cron\/publisher-(minute|tick|daily)$/.test(p),
      ),
    ).toEqual([]);
    expect(pub).toEqual(
      expect.arrayContaining([
        '/cron/publisher-minute',
        '/cron/publisher-tick',
        '/cron/publisher-daily',
      ]),
    );
  });

  it('перечислитель находит цели изоляции AT-CORE-08 (маршруты с :pid/:siteId)', () => {
    const targets = isolationTargets(routes);
    expect(targets.length).toBe(publisherCabinetRoutes(routes).length);
    expect(targets.map((t) => `${t.method} ${t.path}`)).toContain(
      'GET /publisher/products/:pid',
    );
  });
});
