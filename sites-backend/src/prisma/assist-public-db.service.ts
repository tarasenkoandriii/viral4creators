import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { describeDbFailure, describeTarget } from '../shared/db-error';
import { SITES_DB_SCHEMA } from './prisma.service';

/**
 * AssistPublicDb — второй клиент Prisma, под логин-ролью, входящей в
 * `assist_public` (ТЗ помощника §4.3-бис, слой 3).
 *
 * ТОЛЬКО для публичных маршрутов виджета (`/widget/v1/*`, Э2) и того, что
 * они вызывают. У роли нет прав на `assist_admin_*`, кабинеты, участников
 * и challenge (GRANT-ы — миграция `…_sites_core_init`), поэтому даже
 * ошибочный запрос виджета к таблице «Админки» получит от Postgres отказ.
 * Кабинетные маршруты этим клиентом не пользуются — у них `SitesDb`.
 *
 * Адаптер и схема — те же, что у PrismaService (`PrismaPg(…, { schema:
 * 'sites' })`): квалификация имён таблиц, а не search_path, который пулер
 * Supabase в transaction-режиме не держит.
 *
 * Строка — `ASSIST_PUBLIC_DATABASE_URL` (doc/DEPLOYMENT.md, раздел 6.4).
 * Нужна с маршрутами виджета; до них её отсутствие — предупреждение.
 */
@Injectable()
export class AssistPublicDb
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AssistPublicDb.name);

  constructor() {
    super({
      adapter: new PrismaPg(process.env.ASSIST_PUBLIC_DATABASE_URL ?? '', {
        schema: SITES_DB_SCHEMA,
      }),
    });
    // Адаптер ещё не подключался (это делает $connect), так что проверка
    // после super ничего не открывает — просто раньше места нет.
    assertDistinctLogin(
      process.env.ASSIST_PUBLIC_DATABASE_URL,
      process.env.SITES_DATABASE_URL,
    );
  }

  async onModuleInit(): Promise<void> {
    const url = process.env.ASSIST_PUBLIC_DATABASE_URL;
    if (!url) {
      this.logger.warn(
        'ASSIST_PUBLIC_DATABASE_URL не задана — публичным маршрутам виджета базы не будет',
      );
      return;
    }
    try {
      await this.$connect();
    } catch (error) {
      // Не роняем весь сервис: кабинет и вебхуки от этой строки не
      // зависят, а виджетных маршрутов на Э0 ещё нет.
      const info = describeDbFailure(error, url);
      this.logger.error(`assist_public: ${info.message}`);
      this.logger.error(`Что делать: ${info.hint}`);
      return;
    }
    const target = describeTarget(url);
    this.logger.log(
      `Подключено под ролью виджета, схема ${SITES_DB_SCHEMA}${target ? ` (${target})` : ''}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

/** Имя пользователя из строки подключения (без пароля). */
export function loginOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return decodeURIComponent(new URL(url).username) || null;
  } catch {
    return null;
  }
}

/**
 * Публичный клиент под тем же логином, что и основной, — это слой 3
 * изоляции, выключенный молча: владелец схемы читает всё. Лучше упасть на
 * старте с понятной фразой (без пароля в тексте).
 */
export function assertDistinctLogin(
  publicUrl: string | undefined,
  mainUrl: string | undefined,
): void {
  const pub = loginOf(publicUrl);
  if (pub !== null && pub === loginOf(mainUrl)) {
    throw new Error(
      'ASSIST_PUBLIC_DATABASE_URL использует того же пользователя БД, что SITES_DATABASE_URL, — ' +
        'нужна отдельная логин-роль в assist_public (doc/DEPLOYMENT.md, раздел 6.4)',
    );
  }
}
