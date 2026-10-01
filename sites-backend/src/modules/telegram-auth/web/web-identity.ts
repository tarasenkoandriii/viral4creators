/**
 * Что гвард кладёт на запрос, авторизованный cookie веб-кабинета, сверх
 * обычной `req.identity` (её формат тот же, что у initData — site-core
 * разницы не видит). Маршрутам входа/выхода нужна сама сессия.
 */
import type { IdentifiedRequest } from '../identity';

export interface WebSessionInfo {
  id: string;
  expiresAt: Date;
}

export type WebIdentifiedRequest = IdentifiedRequest & {
  /** Есть только при входе по cookie; при initData — `undefined`. */
  webSession?: WebSessionInfo;
};
