/**
 * Гвард ОБРАТНОГО направления «sites-backend → генератор» (Э6-тер (к), ТЗ
 * помощника §5-бис.17 п.6 «генератор отдаёт шаги через внутренний API»).
 *
 * Единственный потребитель — чтение шагов одобренной обучалки для черновика
 * мемо (`client-site-tutorial/memo-steps.controller.ts`): маршрут ТОЛЬКО
 * отдаёт очищенные данные (без значений полей, без входа), ничего не пишет.
 *
 *  - секрет тот же, что у прямого направления (`SITES_TUTORIAL_HMAC_SECRET`),
 *    вызывающий другой — `sites-memo`: он часть подписанной строки, поэтому
 *    подпись генератора к кабинету (`generator-tutorial`) сюда не подходит,
 *    и наоборот (`common/sites-internal-signature.ts`);
 *  - подписаны метод, путь (с id сайта и черновика), пустое тело, метка
 *    времени (±5 мин) и id запроса. Только GET без тела: глобальный разбор
 *    JSON генератора не хранит сырые байты, а подписывать пересобранный JSON
 *    — значит проверять не то, что пришло;
 *  - повтор id в окне — 401 (журнал в памяти процесса: маршрут только
 *    читает, перехвативший запрос получил бы ровно тот же ответ; таблицы
 *    в схеме генератора под это не заводим);
 *  - нет секрета — маршрут ЗАКРЫТ (503), а не открыт.
 */
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  SITES_CALLER_MEMO,
  SITES_HMAC_WINDOW_SEC,
  isUsableSitesSecret,
  verifySitesRequest,
} from '../../common/sites-internal-signature';

const LEDGER_MAX = 10_000;

function refuse(status: HttpStatus, code: string, message: string) {
  return new HttpException({ error: code, code, message }, status);
}

@Injectable()
export class SitesMemoHmacGuard implements CanActivate {
  /** Тесты подменяют env и часы. */
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();
  /** id запроса → до какого времени (мс) он занят. */
  private readonly seen = new Map<string, number>();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const secret = this.env.SITES_TUTORIAL_HMAC_SECRET?.trim();
    if (!isUsableSitesSecret(secret)) {
      throw refuse(
        HttpStatus.SERVICE_UNAVAILABLE,
        'INTERNAL_NOT_CONFIGURED',
        'SITES_TUTORIAL_HMAC_SECRET не задан (≥ 32 символа) — внутренний API закрыт',
      );
    }
    if (req.method !== 'GET') {
      throw refuse(
        HttpStatus.METHOD_NOT_ALLOWED,
        'INTERNAL_BAD_METHOD',
        'Только GET',
      );
    }
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    const nowMs = this.now().getTime();
    const check = verifySitesRequest(secret, {
      method: req.method,
      path,
      body: '',
      headers: req.headers,
      nowSeconds: Math.floor(nowMs / 1000),
      expectedCaller: SITES_CALLER_MEMO,
    });
    if (!check.ok) {
      throw refuse(
        HttpStatus.UNAUTHORIZED,
        `INTERNAL_SIGNATURE_${check.reason.toUpperCase()}`,
        'Подпись внутреннего запроса не принята',
      );
    }
    if (!this.claim(check.requestId, nowMs)) {
      throw refuse(
        HttpStatus.UNAUTHORIZED,
        'INTERNAL_REPLAY',
        'Этот подписанный запрос уже выполнялся',
      );
    }
    return true;
  }

  /** `true` — id новый и занят на окно ±5 мин (с запасом). */
  private claim(requestId: string, nowMs: number): boolean {
    for (const [id, until] of this.seen) {
      if (until > nowMs && this.seen.size < LEDGER_MAX) break;
      if (until <= nowMs || this.seen.size >= LEDGER_MAX) this.seen.delete(id);
    }
    if (this.seen.has(requestId)) return false;
    this.seen.set(requestId, nowMs + 2 * SITES_HMAC_WINDOW_SEC * 1000 + 1000);
    return true;
  }
}
