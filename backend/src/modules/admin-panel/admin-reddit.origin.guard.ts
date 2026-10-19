/**
 * Вкладка «Reddit» админки (P-R-ADM) — строгий барьер CSRF для мутаций
 * (внутренний аудит 19.10.2026, наблюдение D1 Н-D1-5; Р-IA-FXC-5).
 *
 * `AdminSessionGuard` (общий для всей Админки, `common/csrf.ts`) отклоняет
 * чужой `Origin`, но запрос БЕЗ `Origin` пропускает — «это не-браузерный
 * клиент». У вкладки «Reddit» не-браузерных клиентов нет: единственный
 * клиент — Админка в браузере (`admin/src/lib/reddit.ts`, cross-origin
 * `fetch` с `credentials: 'include'`), а браузер на cross-origin `fetch`
 * `Origin` ставит всегда. Поэтому здесь не-safe метод без `Origin`
 * отклоняется (тем же 403 и текстом, что и чужой `Origin`), если только
 * браузер не сказал `Sec-Fetch-Site: same-origin`. Сам `Origin`, когда он
 * есть, по-прежнему сверяет `AdminSessionGuard` со списком `CORS_ORIGIN`.
 *
 * Только этот контроллер: менять общую политику Админки (`csrf.ts`) — не
 * решение одной вкладки.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { CSRF_REJECTED_MESSAGE } from '../../common/csrf';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function redditMutationOriginOk(
  method: string | undefined,
  origin: string | undefined,
  secFetchSite: string | undefined,
): boolean {
  if (SAFE_METHODS.has((method || 'GET').toUpperCase())) return true;
  if (typeof origin === 'string' && origin.trim() !== '') return true;
  return secFetchSite === 'same-origin';
}

@Injectable()
export class AdminRedditOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const header = (name: string): string | undefined => {
      const v = req.headers?.[name];
      return Array.isArray(v) ? v[0] : v;
    };
    if (
      !redditMutationOriginOk(
        req.method,
        header('origin'),
        header('sec-fetch-site'),
      )
    ) {
      throw new ForbiddenException(CSRF_REJECTED_MESSAGE);
    }
    return true;
  }
}
