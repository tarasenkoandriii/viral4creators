/**
 * Аудит 01.10 «перенос `assistAdmin`-прав на ВСЕ маршруты» (план, Э7; ТЗ
 * §3.2, §4.16, К-9) — статически, по метаданным собранного AppModule:
 *  - каждый маршрут кабинета «Админки» (`…/admin-mode*`, `…/connectors*`,
 *    `…/action-log*`, `…/knowledge/admin/*`, `…/learning/admin/*`,
 *    `…/admin-chat*`) требует `productRoles.assistAdmin` — `assist`
 *    (менеджер/оператор «Сайта») к данным «Админки» не даёт ничего;
 *  - кабинет «Админки» (всё, кроме чата сотрудника) — только `owner`;
 *  - публичные маршруты «Админки» — только `/assist-admin/v1/*` (сессия по
 *    employee-JWT), `/wa/v1/*` (HTML iframe) и крон.
 * Новый маршрут «Админки» без прав роняет этот тест, а не прод.
 */
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../app.module';
import { PRODUCT_ROLES_KEY } from '../../modules/site-core/account/site-account.guard';
import type { ProductRoleRequirement } from '../../modules/site-core/account/roles';
import { PUBLIC_ROUTE_KEY } from '../../modules/telegram-auth/allow-apps.decorator';

interface RouteInfo {
  path: string;
  method: string;
  product: ProductRoleRequirement | undefined;
  publicReason: string | undefined;
}

const ADMIN_CABINET =
  /\/(admin-mode|connectors|action-log|knowledge\/admin|learning\/admin|admin-chat)(\/|$)/;

describe('Э7: права «Админки» на всех маршрутах (метаданные AppModule)', () => {
  let routes: RouteInfo[] = [];

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const modules = ref.get(ModulesContainer);
    for (const mod of modules.values()) {
      for (const wrapper of mod.controllers.values()) {
        const cls = wrapper.metatype as
          (new (...a: unknown[]) => unknown) | null;
        if (!cls) continue;
        const base = String(Reflect.getMetadata(PATH_METADATA, cls) ?? '');
        const proto = cls.prototype as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(proto)) {
          const fn = proto[name];
          if (name === 'constructor' || typeof fn !== 'function') continue;
          const sub = Reflect.getMetadata(PATH_METADATA, fn);
          if (sub === undefined) continue;
          const method =
            RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn) as number];
          const path =
            `/${[base, String(sub)].filter(Boolean).join('/')}`.replace(
              /\/+/g,
              '/',
            );
          routes.push({
            path,
            method,
            product:
              Reflect.getMetadata(PRODUCT_ROLES_KEY, fn) ??
              Reflect.getMetadata(PRODUCT_ROLES_KEY, cls),
            publicReason:
              Reflect.getMetadata(PUBLIC_ROUTE_KEY, fn) ??
              Reflect.getMetadata(PUBLIC_ROUTE_KEY, cls),
          });
        }
      }
    }
    routes = routes.filter(
      (r, i, a) =>
        a.findIndex((x) => x.path === r.path && x.method === r.method) === i,
    );
    await ref.close();
  });

  it('маршруты «Админки» нашлись (иначе проверка ниже пуста)', () => {
    const admin = routes.filter((r) => ADMIN_CABINET.test(r.path));
    expect(admin.length).toBeGreaterThanOrEqual(30);
    expect(routes.some((r) => r.path === '/assist-admin/v1/session')).toBe(
      true,
    );
  });

  it('каждый маршрут кабинета «Админки» требует assistAdmin (кроме чата — только owner)', () => {
    const bad: string[] = [];
    for (const r of routes.filter((x) => ADMIN_CABINET.test(x.path))) {
      const allowed = r.product?.assistAdmin as readonly string[] | undefined;
      if (!allowed || allowed.length === 0 || r.product?.assist) {
        bad.push(`${r.method} ${r.path}: нет assistAdmin`);
        continue;
      }
      const chat = /\/admin-chat(\/|$)/.test(r.path);
      if (!chat && (allowed.length !== 1 || allowed[0] !== 'owner')) {
        bad.push(`${r.method} ${r.path}: кабинет «Админки» — только owner`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('публичные маршруты «Админки» — только сессия сотрудника, iframe и крон', () => {
    const pub = routes.filter((r) => r.publicReason && /admin/i.test(r.path));
    const unexpected = pub.filter(
      (r) =>
        !/^\/assist-admin\/v1\//.test(r.path) &&
        !/^\/wa\/v1\//.test(r.path) &&
        !/^\/cron\/assist-admin-/.test(r.path) &&
        !/^\/internal\/admin\/assist/.test(r.path),
    );
    expect(unexpected.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });
});
