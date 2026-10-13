import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { describeDbFailure, describeTarget } from '../shared/db-error';
import { SITES_DB_SCHEMA } from './prisma.service';
import { loginOf } from './assist-public-db.service';

/**
 * PublisherPublicDb — клиент Prisma под логин-ролью, входящей в NOLOGIN-роль
 * `publisher_public` (AI Publisher, решение координатора по Р-PUB-5;
 * миграция `…_publisher_core`).
 *
 * ТОЛЬКО для публичных маршрутов Publisher (`/public/publisher/v1/*`,
 * код `modules/publisher/public/**` — правило графа `publisher-public-db-zone`).
 * Права роли — явный список: чтение представлений `pub_public_products` и
 * `pub_public_contents`, колоночный INSERT минимальной заявки, шифротекста
 * контакта, сессии, события и строки исходящей очереди, окно лимита формы.
 * Кабинеты, помощник, ядро и остальные `pub_*` — 42501 от самого Postgres.
 *
 * Запросы — только сырой SQL с явными колонками (`$queryRaw`/`$executeRaw`):
 * модельные методы Prisma выбирают всю строку (и RETURNING всех колонок),
 * а у роли SELECT есть лишь на несколько колонок `pub_leads`.
 *
 * Адаптер и схема — те же, что у PrismaService и AssistPublicDb
 * (`PrismaPg(…, { schema: 'sites' })`): квалификация имён, а не search_path,
 * который пулер Supabase в transaction-режиме не держит.
 *
 * Строка — `PUBLISHER_PUBLIC_DATABASE_URL`. Без неё публичный приём закрыт
 * (503 с понятным логом), кабинет работает.
 */
export function publisherPublicClientOptions(
  url: string,
): Prisma.PrismaClientOptions {
  return { adapter: new PrismaPg(url, { schema: SITES_DB_SCHEMA }) };
}

/** Публичная строка задана (без неё маршруты отвечают 503). */
export function publisherPublicConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !!env.PUBLISHER_PUBLIC_DATABASE_URL?.trim();
}

/**
 * Публичный клиент под тем же логином, что основной или виджетный, — это
 * изоляция, выключенная молча (владелец схемы читает всё, а роль виджета —
 * таблицы помощника). Лучше упасть на старте с понятной фразой (без пароля).
 */
export function assertDistinctPublisherLogin(
  publisherUrl: string | undefined,
  others: { main?: string; assist?: string },
): void {
  const pub = loginOf(publisherUrl);
  if (pub === null) return;
  if (pub === loginOf(others.main) || pub === loginOf(others.assist)) {
    throw new Error(
      'PUBLISHER_PUBLIC_DATABASE_URL использует того же пользователя БД, что SITES_DATABASE_URL ' +
        'или ASSIST_PUBLIC_DATABASE_URL, — нужна отдельная логин-роль в publisher_public ' +
        '(doc/DEPLOYMENT.md, раздел sites-backend)',
    );
  }
}

@Injectable()
export class PublisherPublicDb
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PublisherPublicDb.name);

  constructor() {
    super(
      publisherPublicClientOptions(
        process.env.PUBLISHER_PUBLIC_DATABASE_URL ?? '',
      ),
    );
    assertDistinctPublisherLogin(process.env.PUBLISHER_PUBLIC_DATABASE_URL, {
      main: process.env.SITES_DATABASE_URL,
      assist: process.env.ASSIST_PUBLIC_DATABASE_URL,
    });
  }

  /** Есть ли строка подключения (публичные маршруты без неё — 503). */
  get configured(): boolean {
    return publisherPublicConfigured();
  }

  async onModuleInit(): Promise<void> {
    const url = process.env.PUBLISHER_PUBLIC_DATABASE_URL;
    if (!url) {
      this.logger.warn(
        'PUBLISHER_PUBLIC_DATABASE_URL не задана — публичный приём заявок и событий Publisher закрыт (503)',
      );
      return;
    }
    try {
      await this.$connect();
    } catch (error) {
      // Не роняем сервис: кабинет и остальные продукты от этой строки не
      // зависят; публичный маршрут ответит 503.
      const info = describeDbFailure(error, url);
      this.logger.error(`publisher_public: ${info.message}`);
      this.logger.error(`Что делать: ${info.hint}`);
      return;
    }
    const target = describeTarget(url);
    this.logger.log(
      `Подключено под ролью publisher_public, схема ${SITES_DB_SCHEMA}${target ? ` (${target})` : ''}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
