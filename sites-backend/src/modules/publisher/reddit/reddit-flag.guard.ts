/**
 * AI Publisher, P-R — выключатель раздела Reddit (reddit-manual-mvp-
 * adapted.md §M1.0; AT-RD-17). Пока `PUBLISHER_REDDIT_ENABLED` не `true`,
 * КАЖДЫЙ маршрут `/publisher/products/:pid/reddit/**` отвечает 404
 * `PUB_NOT_FOUND` без `details` — раньше членства в кабинете, ролей и
 * разбора тела: ответ участнику неотличим от отсутствующего объекта,
 * побочных эффектов нет. Стоит первым гвардом контроллера (до гвардов
 * `PubCabinetController`); глобальная проверка входа Telegram/веб идёт
 * раньше — аноним получает обычный 401, как на любом маршруте кабинета.
 */
import { CanActivate, Injectable } from '@nestjs/common';
import { publisherRedditEnabled } from '../../../config/publisher-env';
import { PubError } from '../core/errors';

@Injectable()
export class RedditEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!publisherRedditEnabled()) throw new PubError('PUB_NOT_FOUND');
    return true;
  }
}
