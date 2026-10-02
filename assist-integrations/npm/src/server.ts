/**
 * Серверные помощники для бэкенда заказчика на Node — T (Э3): подпись
 * вебхука целей s2s (§5-тер.1) и userHash для `identify` (§3-бис.2). Тот же
 * формат, что проверяет sites-backend (assist-analytics/webhook-signature.ts):
 * общие векторы — fixtures/goal-webhook-vectors.json. Секреты — только на
 * сервере заказчика (в браузер не отдавать).
 */
/// <reference types="node" />
// Типы Node — только этому файлу: `./server` исполняется на бэкенде
// заказчика, а index/react не должны видеть node-глобалы.
import { createHmac } from "crypto";
import { GOAL_WEBHOOK_SIGNATURE_HEADER } from "./brand";

function hmacHex(secret: string, data: string): string {
  if (typeof secret !== "string" || !secret) {
    throw new Error("assist: пустой секрет");
  }
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

/**
 * Значение заголовка подписи: `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<тело>")>`.
 * `rawBody` — ровно те байты, что уйдут в теле (подписывается строка UTF-8).
 */
export function signGoalWebhook(
  secret: string,
  rawBody: string,
  unixSec?: number,
): string {
  const t = unixSec ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(t) || t <= 0) {
    throw new Error("assist: время подписи — целые секунды unix");
  }
  return `t=${t},v1=${hmacHex(secret, `${t}.${rawBody}`)}`;
}

/** userHash для `V4CAssist('identify', { externalId, userHash })`. */
export function identityUserHash(secret: string, externalId: string): string {
  if (typeof externalId !== "string" || !externalId) {
    throw new Error("assist: пустой externalId");
  }
  return hmacHex(secret, externalId);
}

export interface GoalWebhookEvent {
  goalKey: string;
  orderId: string;
  value?: number | null;
  currency?: string | null;
  status: "completed" | "refunded" | "cancelled";
  occurredAt: string;
}

/**
 * Готовый запрос события цели: тело (сериализуется ОДИН раз — подпись и
 * отправка видят одни байты) и заголовки (подпись, `Idempotency-Key` =
 * orderId). Отправить — любым HTTP-клиентом на endpoint из TMA.
 */
export function goalWebhookRequest(
  secret: string,
  event: GoalWebhookEvent,
  unixSec?: number,
): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(event);
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      [GOAL_WEBHOOK_SIGNATURE_HEADER]: signGoalWebhook(secret, body, unixSec),
      "Idempotency-Key": event.orderId,
    },
  };
}
