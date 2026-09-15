/**
 * PublicOriginGuard — барьер происхождения для публичных маршрутов БЕЗ
 * cookie (doc/LANDING-TUTORIAL-AI-CONSULTANT-SPEC.md §4.2.3).
 *
 * Первый браузерный клиент лендинга (`AssistantWidget.tsx`) не шлёт
 * cookie и не авторизован — CORS уже решает, может ли чужая страница
 * ПРОЧИТАТЬ ответ, но не мешает ей ОТПРАВИТЬ запрос без preflight на
 * safe-метод, а на POST preflight проходит, если наш CORS отвечает на
 * OPTIONS без ошибки для ЛЮБОГО origin (см. `main.ts` — там `callback`
 * получает ошибку для чужого origin, так что фактическая защита уже
 * есть в CORS). Этот гвард — вторая, явная линия ровно на маршрутах
 * ассистента: без него не-браузерный клиент (нет `Origin`, значит и нет
 * CORS-проверки браузера) мог бы жечь дневной бюджет (§7.2) скриптом.
 * Не-браузерные клиенты (curl, сервер-сервер) по-прежнему пропускаются —
 * это симметрично `isOriginAllowed`/`OriginGuard`: пресекать реальную
 * подмену browser-Origin здесь бессмысленно, `Origin` подделать нельзя,
 * а полное отсутствие заголовка — не признак атаки.
 *
 * НЕ используется `isOriginAllowed` из `common/csrf.ts` — та защищает
 * cookie-маршруты и осознанно не поддерживает `*.vercel.app` (см. её
 * доккомментарий); здесь домены превью лендинга обязаны проходить, как
 * и в обычном CORS, поэтому сравнение — `matchesAllowedOrigin`, та же
 * функция, что и `app.enableCors()` в `main.ts` (уточнено при аудите ТЗ
 * 15.09.2026, §4.2.3).
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { matchesAllowedOrigin } from './cors-origin-match';

export const PUBLIC_ORIGIN_REJECTED_MESSAGE =
  'Запрос с этого источника отклонён';

@Injectable()
export class PublicOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const origin = req.headers.origin as string | undefined;
    // Нет Origin — не браузер (curl, сервер-сервер, тест) — пропускаем,
    // тот же принцип, что у OriginGuard/isOriginAllowed.
    if (!origin) return true;

    const allowed = (process.env.CORS_ORIGIN || 'http://localhost:5173')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (!matchesAllowedOrigin(origin, allowed)) {
      throw new ForbiddenException(PUBLIC_ORIGIN_REJECTED_MESSAGE);
    }
    return true;
  }
}
