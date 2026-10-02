/**
 * Клиент внутреннего API sites-backend для вкладки «Помощник» админки
 * (ТЗ помощника §8; Э4). Генератор НЕ получает DSN схемы `sites` и ключей
 * её секретов (аудит слияния 02.10.2026 §3.0 п.2): только HTTP к
 * `SITES_BACKEND_URL` с секретом `SITES_INTERNAL_SECRET` в заголовке
 * `X-Sites-Internal-Secret` (по образцу `X-Relay-Secret`), id оператора —
 * `X-Admin-Actor` (журнал доступа на стороне sites-backend).
 *
 * Ошибки: не настроено — 503 с понятным текстом (вкладка показывает
 * «не настроено», остальная админка работает); ответ sites-backend 4xx —
 * тот же код и текст оператору; сеть/5xx — 502.
 */
import {
  BadGatewayException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

const TIMEOUT_MS = 20_000;

export type AssistAdminMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

@Injectable()
export class AdminAssistClient {
  private readonly logger = new Logger(AdminAssistClient.name);
  /** Тесты подменяют сеть и env. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  env: NodeJS.ProcessEnv = process.env;

  configured(): boolean {
    return !!this.base() && !!this.secret();
  }

  private base(): string | null {
    const raw = this.env.SITES_BACKEND_URL?.trim();
    if (!raw) return null;
    try {
      const u = new URL(raw);
      if (
        u.protocol !== 'https:' &&
        u.hostname !== 'localhost' &&
        u.hostname !== 'sites-backend'
      ) {
        return null;
      }
      return u.origin;
    } catch {
      return null;
    }
  }

  private secret(): string | null {
    const s = this.env.SITES_INTERNAL_SECRET?.trim();
    return s && s.length >= 16 ? s : null;
  }

  async call<T>(
    method: AssistAdminMethod,
    path: string,
    actor: string,
    body?: unknown,
  ): Promise<T> {
    const base = this.base();
    const secret = this.secret();
    if (!base || !secret) {
      throw new ServiceUnavailableException(
        'Помощник не подключён к админке: задайте SITES_BACKEND_URL и SITES_INTERNAL_SECRET (doc/DEPLOYMENT.md §6.12)',
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(`${base}/internal/admin/assist${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'X-Sites-Internal-Secret': secret,
          'X-Admin-Actor': actor,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      this.logger.warn(
        `sites-backend не ответил на ${method} ${path}: ${(err as Error).name}`,
      );
      throw new BadGatewayException('Бэкенд клиентских сайтов не ответил');
    } finally {
      clearTimeout(timer);
    }
    const json = (await res.json().catch(() => null)) as {
      data?: T;
      error?: { code?: string; message?: string };
    } | null;
    if (!res.ok) {
      this.logger.warn(
        `sites-backend ответил ${res.status} на ${method} ${path}`,
      );
      if (res.status >= 400 && res.status < 500 && res.status !== 401) {
        throw new HttpException(
          {
            message: json?.error?.message ?? 'Запрос отклонён',
            error: json?.error?.code ?? 'SITES_BACKEND_ERROR',
          },
          res.status,
        );
      }
      throw new BadGatewayException(
        res.status === 401
          ? 'Неверный SITES_INTERNAL_SECRET: секреты генератора и sites-backend не совпадают'
          : 'Бэкенд клиентских сайтов вернул ошибку',
      );
    }
    // sites-backend отвечает конвертом { success, data, meta }.
    return (json?.data ?? null) as T;
  }
}
