import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { describeDbFailure, describeTarget } from '../shared/db-error';

/** Postgres-схема sites-backend (prisma.config.ts, миграции). */
export const SITES_DB_SCHEMA = 'sites';

/**
 * PrismaService — сырой клиент схемы `sites`.
 *
 * ## Как выбирается схема
 *
 * Таблицы sites-backend живут в postgres-схеме `sites`, а не в `public`
 * генератора. Драйвер-адаптер Prisma 7 умеет это сам: опция
 * `PrismaPg(…, { schema })` (`PrismaPgOptions.schema` в типах
 * @prisma/adapter-pg 7.10 — «The name of the schema to use in generated
 * queries») квалифицирует ИМЕНА ТАБЛИЦ в каждом сгенерированном запросе.
 * `search_path` для этого НЕ нужен — и это важно: пулер Supabase в
 * transaction-режиме не гарантирует, что `SET search_path` или
 * `options=-c search_path=…` в строке подключения доживут до следующего
 * запроса (соединение из пула — чужое).
 *
 * Следствие для сырого SQL (`$queryRaw`, поиск по векторам в Э1): там
 * квалификации никто не добавит — пишите `"sites"."таблица"` и
 * `"extensions"."vector"` явно.
 *
 * ## Не используйте этот клиент для таблиц кабинета напрямую
 *
 * Запросы к таблицам кабинета идут через `SitesDb.forAccount(accountId)`
 * (prisma/sites-db.service.ts): там Prisma-extension тенанта, и запрос без
 * кабинета бросает. Сырой клиент — только для `SitesDb` и здоровья.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      adapter: new PrismaPg(process.env.SITES_DATABASE_URL ?? '', {
        schema: SITES_DB_SCHEMA,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    if (!process.env.SITES_DATABASE_URL) {
      // Локально без базы сервис поднимается (health ответит degraded);
      // в проде до сюда не доходит — validateConfiguration падает раньше.
      this.logger.warn(
        'SITES_DATABASE_URL не задана — запросы к базе будут падать',
      );
      return;
    }
    try {
      await this.$connect();
    } catch (error) {
      const info = describeDbFailure(error, process.env.SITES_DATABASE_URL);
      this.logger.error(info.message);
      this.logger.error(`Что делать: ${info.hint}`);
      throw error;
    }
    const target = describeTarget(process.env.SITES_DATABASE_URL);
    this.logger.log(
      `Подключено к Postgres, схема ${SITES_DB_SCHEMA}${target ? ` (${target})` : ''}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
