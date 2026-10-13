/**
 * AI Publisher — стенд ядра для db/http-тестов (P-A1): Nest-модуль ядра на
 * тестовой базе (`SITES_DIRECT_URL`, владелец схемы), фейки портов и
 * вкладов (`fake-ports.ts`), по желанию — HTTP-приложение с настоящим
 * `TelegramIdentityGuard` и конвертом (`configureApp`), как
 * `site-core.http.spec.ts`. Пакеты этапа 1 добавляют свои модули в
 * `imports`.
 */
import {
  Logger,
  type INestApplication,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { configureApp } from '../../../../app.setup';
import { loadConfiguration } from '../../../../config/configuration';
import { testPrisma } from '../../../../prisma/ci-describe.testing';
import { PrismaModule } from '../../../../prisma/prisma.module';
import { PrismaService } from '../../../../prisma/prisma.service';
import { SitesDb } from '../../../../prisma/sites-db.service';
import { TelegramAuthModule } from '../../../telegram-auth/telegram-auth.module';
import {
  TEST_ASSIST_TOKEN,
  TEST_QA_TOKEN,
  signInitData,
} from '../../../telegram-auth/test-init-data';
import { PublisherCoreModule } from '../publisher-core.module';
import {
  fakePortProviders,
  fakePorts,
  fakesBesides,
  type FakePorts,
} from './fake-ports';

export interface CoreStack {
  prisma: PrismaService;
  db: SitesDb;
  mod: TestingModule;
  fakes: FakePorts;
  app?: INestApplication;
  close(): Promise<void>;
}

export interface CoreStackOptions {
  /** Фейки портов и всех вкладов (по умолчанию — да). */
  fakes?: boolean;
  /** Поднять HTTP-приложение (telegram-auth, конверт, фильтры). */
  http?: boolean;
  imports?: ModuleMetadata['imports'];
  providers?: Provider[];
  prisma?: PrismaService;
}

const ENV_KEYS = [
  'ASSIST_BOT_TOKEN',
  'QA_BOT_TOKEN',
  'CRON_SECRET',
  'ALLOW_DEV_AUTH',
] as const;

export async function coreStack(
  opts: CoreStackOptions = {},
): Promise<CoreStack> {
  const prisma = opts.prisma ?? testPrisma();
  const fakes = fakePorts();
  const saved: Record<string, string | undefined> = {};
  if (opts.http) {
    Logger.overrideLogger(false);
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.ASSIST_BOT_TOKEN = TEST_ASSIST_TOKEN;
    process.env.QA_BOT_TOKEN = TEST_QA_TOKEN;
    process.env.CRON_SECRET = 'cron-secret-for-test';
    delete process.env.ALLOW_DEV_AUTH;
  }
  const mod = await Test.createTestingModule({
    imports: [
      PrismaModule,
      ...(opts.http ? [TelegramAuthModule] : []),
      PublisherCoreModule,
      ...(opts.imports ?? []),
    ],
    providers: [
      // Фейки — только для того, чего не дают настоящие модули `imports`.
      ...(opts.fakes === false
        ? []
        : fakesBesides(fakePortProviders(fakes), opts.imports)),
      ...(opts.providers ?? []),
    ],
  })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
  let app: INestApplication | undefined;
  if (opts.http) {
    app = mod.createNestApplication();
    configureApp(app, loadConfiguration({}));
    await app.init();
  } else {
    await mod.init();
  }
  return {
    prisma,
    db: mod.get(SitesDb),
    mod,
    fakes,
    app,
    async close() {
      if (app) await app.close();
      else await mod.close();
      if (!opts.prisma) await prisma.$disconnect();
      for (const k of ENV_KEYS) {
        if (!(k in saved)) continue;
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    },
  };
}

/** Заголовки запроса участника (initData бота помощника + кабинет). */
export function asMember(
  telegramId: bigint,
  accountId?: string,
): Record<string, string> {
  return {
    'X-Telegram-App': 'assist',
    'X-Telegram-Init-Data': signInitData({
      botToken: TEST_ASSIST_TOKEN,
      userId: Number(telegramId),
    }),
    ...(accountId ? { 'X-Site-Account': accountId } : {}),
  };
}
