import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { describeDbFailure, describeTarget } from './db-error';

/**
 * PrismaService
 *
 * Thin Nest wrapper around PrismaClient. One instance per running process
 * (standard Nest singleton scope) — on Vercel that means one per Function
 * invocation, which is exactly why DATABASE_URL must point at Supabase's
 * pooled (PgBouncer) connection string rather than a direct one: many
 * concurrent invocations each holding their own PrismaClient would
 * otherwise each open their own direct Postgres connection and exhaust
 * Supabase's connection limit. See doc/PRISMA-SUPABASE.md.
 *
 * Prisma 7 requires an explicit driver adapter — schema.prisma no longer
 * carries a connection string at all (see its own comment, and
 * ../../prisma.config.ts). DATABASE_URL is read directly here, same env
 * var as always, just no longer routed through the schema.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch (error) {
      // Понятная диагностика вместо голого stack trace драйвера
      // (этап 29): куда стучались, что именно не так и что чинить.
      // Пароль в лог не попадает — см. db-error.ts.
      const info = describeDbFailure(error);
      this.logger.error(info.message);
      this.logger.error(`Что делать: ${info.hint}`);
      throw error;
    }
    this.logger.log(
      `Connected to Postgres via Prisma${describeTarget(process.env.DATABASE_URL) ? ` (${describeTarget(process.env.DATABASE_URL)})` : ''}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
