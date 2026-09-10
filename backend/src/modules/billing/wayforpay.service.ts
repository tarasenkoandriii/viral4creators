/**
 * WayForPayService — тонкий клиент WayForPay для оплаты картой (этап 62,
 * ТЗ §41.2). Сырой `axios`/подпись руками, без SDK — конвенция проекта
 * (см. `google-oauth.service.ts`). Поля и порядок конкатенации для
 * `merchantSignature` сверены по официальной документации WayForPay
 * (wiki.wayforpay.com, «Accept payment (Purchase)», «To accept payment
 * host2host (Charge)» — проверено 2026-09-08, при расхождении с реальным
 * поведением API сверить заново перед продакшн-выкаткой).
 *
 * ## Форма покупки (redirect), а не API-first приём карты
 *
 * «Оплата через API» у WayForPay всё равно означает передачу PAN-данных
 * карты на свой сервер либо редирект на их 3DS-страницу без выигрыша —
 * лишний PCI-DSS периметр без пользы. Подписанная redirect-форма на
 * `secure.wayforpay.com/pay` ничего не требует от нашего сервера, кроме
 * `merchantSignature`.
 *
 * ## Регулярные платежи (recToken)
 *
 * При первой покупке подписки, если мерчант-аккаунт включён на regular
 * payments, WayForPay возвращает `recToken` в вебхуке — сохраняется ТОЛЬКО
 * зашифрованным (`token-crypto.ts` + `PAYMENT_TOKEN_KEY`) в
 * `Subscription.recTokenEnc`. `chargeRecToken()` — то, чем
 * `billing-renewal/wayforpay-renewal.service.ts` продлевает подписку:
 * настоящее инициируемое СЕРВЕРОМ списание (в отличие от Stars, где
 * продление делает сам Telegram).
 */

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { createHmac, timingSafeEqual } from 'crypto';
import { loadConfiguration } from '../../config/configuration';

const PURCHASE_URL = 'https://secure.wayforpay.com/pay';
const API_URL = 'https://api.wayforpay.com/api';

export interface PurchaseFormInput {
  orderReference: string;
  /** В ОСНОВНЫХ единицах валюты (гривны, не копейки) — так их ждёт форма
   * WayForPay, в отличие от `Payment.amount` в БД (минорные единицы). */
  amount: number;
  currency: string;
  productName: string;
  returnUrl: string;
  serviceUrl: string;
}

export interface PurchaseForm {
  url: string;
  fields: Record<string, string>;
}

export interface ChargeResult {
  ok: boolean;
  transactionStatus: string;
  reasonCode: number;
  recToken: string | null;
  rawPayload: unknown;
}

@Injectable()
export class WayForPayService {
  private readonly logger = new Logger(WayForPayService.name);

  private cfg() {
    return loadConfiguration().billing;
  }

  configured(): boolean {
    const {
      wayforpayMerchantAccount,
      wayforpayMerchantSecret,
      wayforpayDomain,
    } = this.cfg();
    return !!(
      wayforpayMerchantAccount &&
      wayforpayMerchantSecret &&
      wayforpayDomain
    );
  }

  /** Форма покупки — редирект на `secure.wayforpay.com/pay` с этими
   * полями (`<form method="POST">` на фронтенде, тот же приём, что
   * OAuth-редирект этапа 61, только POST вместо GET). */
  buildPurchaseForm(input: PurchaseFormInput): PurchaseForm {
    const { wayforpayMerchantAccount, wayforpayDomain } = this.cfg();
    const orderDate = Math.floor(Date.now() / 1000);
    const signature = this.hmacMd5(
      [
        wayforpayMerchantAccount,
        wayforpayDomain,
        input.orderReference,
        String(orderDate),
        formatAmount(input.amount),
        input.currency,
        input.productName,
        '1',
        formatAmount(input.amount),
      ].join(';'),
    );
    return {
      url: PURCHASE_URL,
      fields: {
        merchantAccount: wayforpayMerchantAccount,
        merchantDomainName: wayforpayDomain,
        merchantSignature: signature,
        orderReference: input.orderReference,
        orderDate: String(orderDate),
        amount: formatAmount(input.amount),
        currency: input.currency,
        'productName[]': input.productName,
        'productCount[]': '1',
        'productPrice[]': formatAmount(input.amount),
        returnUrl: input.returnUrl,
        serviceUrl: input.serviceUrl,
      },
    };
  }

  /** Подпись входящего вебхука (`serviceUrl`) — поля берутся из ТЕЛА
   * запроса WayForPay, порядок фиксирован протоколом. */
  verifyServiceCallback(body: {
    merchantAccount: string;
    orderReference: string;
    amount: number | string;
    currency: string;
    authCode?: string;
    cardPan?: string;
    transactionStatus: string;
    reasonCode: number | string;
    merchantSignature: string;
  }): boolean {
    const expected = this.hmacMd5(
      [
        body.merchantAccount,
        body.orderReference,
        String(body.amount),
        body.currency,
        body.authCode ?? '',
        body.cardPan ?? '',
        body.transactionStatus,
        String(body.reasonCode),
      ].join(';'),
    );
    // Е-1.6 шестого аудита: было обычное `===` — непоследовательно с
    // `stars-invoice-payload.util.ts`, которая для той же задачи (сверка
    // подписи входящих данных) уже использует `timingSafeEqual`.
    // Эксплуатируемость невысокая (подпись — HMAC-MD5 плюс сетевой шум),
    // но нет причины держать в одном модуле два разных уровня строгости
    // для одной и той же операции у двух платёжных провайдеров.
    return safeEqual(expected, body.merchantSignature);
  }

  /** Квитанция, которую WayForPay ждёт в ответ на вебхук — без неё он
   * повторяет доставку по расписанию, твёрдое требование протокола. */
  buildWebhookAck(orderReference: string): {
    orderReference: string;
    status: 'accept';
    time: number;
    signature: string;
  } {
    const time = Math.floor(Date.now() / 1000);
    const signature = this.hmacMd5(
      [orderReference, 'accept', String(time)].join(';'),
    );
    return { orderReference, status: 'accept', time, signature };
  }

  /** Регулярное списание по сохранённому `recToken` — host2host `Charge`
   * (`api.wayforpay.com/api`), используется ТОЛЬКО кроном продления
   * подписки, не пользовательским запросом напрямую. */
  async chargeRecToken(input: {
    recToken: string;
    orderReference: string;
    amount: number;
    currency: string;
    productName: string;
  }): Promise<ChargeResult> {
    const { wayforpayMerchantAccount, wayforpayDomain } = this.cfg();
    const orderDate = Math.floor(Date.now() / 1000);
    const signature = this.hmacMd5(
      [
        wayforpayMerchantAccount,
        wayforpayDomain,
        input.orderReference,
        String(orderDate),
        formatAmount(input.amount),
        input.currency,
        input.productName,
        '1',
        formatAmount(input.amount),
      ].join(';'),
    );
    const res = await axios.post<{
      transactionStatus?: string;
      reasonCode?: number;
      recToken?: string;
    }>(API_URL, {
      transactionType: 'CHARGE',
      merchantAccount: wayforpayMerchantAccount,
      merchantAuthType: 'SimpleSignature',
      merchantDomainName: wayforpayDomain,
      merchantSignature: signature,
      apiVersion: 1,
      orderReference: input.orderReference,
      orderDate,
      amount: formatAmount(input.amount),
      currency: input.currency,
      recToken: input.recToken,
      productName: [input.productName],
      productPrice: [formatAmount(input.amount)],
      productCount: [1],
    });
    const status = res.data.transactionStatus ?? 'Declined';
    return {
      ok: status === 'Approved',
      transactionStatus: status,
      reasonCode: res.data.reasonCode ?? -1,
      recToken: res.data.recToken ?? null,
      rawPayload: res.data,
    };
  }

  private hmacMd5(data: string): string {
    const { wayforpayMerchantSecret } = this.cfg();
    return createHmac('md5', wayforpayMerchantSecret)
      .update(data, 'utf8')
      .digest('hex');
  }
}

function formatAmount(amount: number): string {
  // WayForPay ждёт сумму в ОСНОВНЫХ единицах валюты с точкой, без хвостовых
  // нулей сверх необходимого (документированный пример — "0.13").
  return String(Math.round(amount * 100) / 100);
}

/** Сравнение постоянного времени (Е-1.6 шестого аудита) — тот же приём,
 * что `safeEqual` в `stars-invoice-payload.util.ts`. `timingSafeEqual`
 * требует буферы одинаковой длины (иначе бросает исключение), поэтому при
 * несовпадении длин сверяем буфер сам с собой — время выполнения этой
 * ветки не должно отличаться от штатной и тем самым не выдаёт длину
 * ожидаемой подписи атакующему. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
