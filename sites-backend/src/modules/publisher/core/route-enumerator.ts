/**
 * AI Publisher — перечислитель маршрутов собранного Nest-приложения (P-A1,
 * проектный документ §16.2; основа AT-CORE-08 этапа Z: `z-isolation.spec`
 * вызывает каждый маршрут с `:pid`/`:siteId` от чужого кабинета и ждёт
 * 404; маршрут вне матрицы ролей роняет тест — `roles.spec.ts`).
 *
 * Читает метаданные контроллеров (`PATH_METADATA`, `METHOD_METADATA`) и
 * декораторы прав: `@PubAllow`, `@RequireProductRoles`, `@PublicRoute`,
 * `@AllowApps`. Ни одного запроса не делает.
 */
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import type { ProductRoleRequirement } from '../../site-core/account/roles';
import { PRODUCT_ROLES_KEY } from '../../site-core/account/site-account.guard';
import {
  ALLOW_APPS_KEY,
  PUBLIC_ROUTE_KEY,
} from '../../telegram-auth/allow-apps.decorator';
import { PUB_ACTIONS_KEY, PUBLISHER_ROUTE_PREFIX } from './pub-role.guard';
import type { PubAction } from './roles';

export interface RouteInfo {
  method: string;
  /** `/publisher/products/:pid/parameters` — с ведущим `/`. */
  path: string;
  controller: string;
  handler: string;
  pubActions: PubAction[] | undefined;
  productRoles: ProductRoleRequirement | undefined;
  publicReason: string | undefined;
  allowApps: string[] | undefined;
  /** Параметры пути (`pid`, `siteId`, …). */
  params: string[];
}

type Ctor = new (...args: unknown[]) => unknown;

function routesOfController(cls: Ctor): RouteInfo[] {
  const out: RouteInfo[] = [];
  const raw = Reflect.getMetadata(PATH_METADATA, cls) as
    string | string[] | undefined;
  const bases = Array.isArray(raw) ? raw : [raw ?? ''];
  const proto = cls.prototype as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(proto)) {
    const fn = proto[name];
    if (name === 'constructor' || typeof fn !== 'function') continue;
    const sub = Reflect.getMetadata(PATH_METADATA, fn) as
      string | string[] | undefined;
    if (sub === undefined) continue;
    const method =
      RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn) as number];
    const meta = <T>(key: string): T | undefined =>
      (Reflect.getMetadata(key, fn) as T | undefined) ??
      (Reflect.getMetadata(key, cls) as T | undefined);
    for (const base of bases) {
      for (const s of Array.isArray(sub) ? sub : [sub]) {
        const path =
          `/${[base, s].filter(Boolean).join('/')}`
            .replace(/\/+/g, '/')
            .replace(/\/$/, '') || '/';
        out.push({
          method,
          path,
          controller: cls.name,
          handler: name,
          pubActions: meta<PubAction[]>(PUB_ACTIONS_KEY),
          productRoles: meta<ProductRoleRequirement>(PRODUCT_ROLES_KEY),
          publicReason: meta<string>(PUBLIC_ROUTE_KEY),
          allowApps: meta<string[]>(ALLOW_APPS_KEY),
          params: [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]),
        });
      }
    }
  }
  return out;
}

/** Все маршруты всех модулей приложения (без повторов). */
export function enumerateRoutes(modules: ModulesContainer): RouteInfo[] {
  const seen = new Set<string>();
  const out: RouteInfo[] = [];
  for (const mod of modules.values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype as Ctor | null;
      if (!cls) continue;
      for (const r of routesOfController(cls)) {
        const k = `${r.method} ${r.path}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(r);
      }
    }
  }
  return out.sort((a, b) =>
    a.path === b.path
      ? a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path),
  );
}

/** Маршруты контроллеров по списку классов (юнит-тесты без сборки приложения). */
export function enumerateControllers(classes: readonly Ctor[]): RouteInfo[] {
  return classes.flatMap(routesOfController);
}

/** Маршруты кабинета Publisher (`/publisher/*`). */
export function publisherCabinetRoutes(
  routes: readonly RouteInfo[],
): RouteInfo[] {
  const prefix = `/${PUBLISHER_ROUTE_PREFIX}/`;
  return routes.filter((r) => r.path.startsWith(prefix));
}

/**
 * Маршруты для проверки изоляции (AT-CORE-08): кабинетные с `:pid` или
 * `:siteId` — вызов с id чужого кабинета обязан дать 404.
 */
export function isolationTargets(routes: readonly RouteInfo[]): RouteInfo[] {
  return publisherCabinetRoutes(routes).filter(
    (r) => r.params.includes('pid') || r.params.includes('siteId'),
  );
}

/** Подстановка параметров пути (`:pid` → id). Неизвестный параметр — `x`. */
export function fillPath(path: string, values: Record<string, string>): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_m, k: string) =>
    encodeURIComponent(values[k] ?? 'x'),
  );
}
