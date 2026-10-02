/**
 * HTTP-стенд кабинета передачи (H): настоящие гварды (initData бота
 * помощника → участник кабинета), конверт ответа, маршруты H и site-core;
 * сервисы — экземпляры HandoffStack (настоящий Postgres, фейки ИИ/Telegram).
 */
import {
  DynamicModule,
  Global,
  INestApplication,
  Module,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { configureApp } from '../../../app.setup';
import { loadConfiguration } from '../../../config/configuration';
import { AssistPublicDb } from '../../../prisma/assist-public-db.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import { SiteCoreModule } from '../../site-core/site-core.module';
import { TelegramAuthModule } from '../../telegram-auth/telegram-auth.module';
import {
  TEST_ASSIST_TOKEN,
  TEST_QA_TOKEN,
  signInitData,
} from '../../telegram-auth/test-init-data';
import { HandoffCabinetController } from '../cabinet/handoff-cabinet.controller';
import {
  ConversationsService,
  HandoffSettingsService,
} from '../cabinet/conversations.service';
import { HandoffDispatcher } from '../system/handoff-dispatcher.service';
import { HandoffOperatorActions } from '../system/handoff-operator.service';
import { AssistHandoffTickController } from '../system/handoff-tick.controller';
import type { HandoffStack } from './handoff-stack.testing';

@Global()
@Module({})
class HandoffInfraModule {
  static with(st: HandoffStack): DynamicModule {
    return {
      module: HandoffInfraModule,
      providers: [
        { provide: PrismaService, useValue: st.owner },
        { provide: SitesDb, useValue: new SitesDb(st.owner) },
        { provide: AssistPublicDb, useValue: st.publicDb },
      ],
      exports: [PrismaService, SitesDb, AssistPublicDb],
    };
  }
}

const ENV_KEYS = [
  'ASSIST_BOT_TOKEN',
  'QA_BOT_TOKEN',
  'CRON_SECRET',
  'ALLOW_DEV_AUTH',
] as const;

export class HandoffHttp {
  app!: INestApplication;
  private readonly saved: Record<string, string | undefined> = {};

  async init(st: HandoffStack): Promise<this> {
    for (const k of ENV_KEYS) this.saved[k] = process.env[k];
    process.env.ASSIST_BOT_TOKEN = TEST_ASSIST_TOKEN;
    process.env.QA_BOT_TOKEN = TEST_QA_TOKEN;
    process.env.CRON_SECRET = 'cron-secret-for-handoff-test';
    delete process.env.ALLOW_DEV_AUTH;
    const mod = await Test.createTestingModule({
      imports: [
        HandoffInfraModule.with(st),
        TelegramAuthModule,
        SiteCoreModule,
      ],
      controllers: [HandoffCabinetController, AssistHandoffTickController],
      providers: [
        { provide: ConversationsService, useValue: st.conversations },
        { provide: HandoffSettingsService, useValue: st.settings },
        { provide: HandoffOperatorActions, useValue: st.actions },
        { provide: HandoffDispatcher, useValue: st.dispatcher },
      ],
    }).compile();
    this.app = mod.createNestApplication({ logger: false });
    configureApp(this.app, loadConfiguration({}));
    await this.app.init();
    return this;
  }

  async close(): Promise<void> {
    await this.app?.close();
    for (const k of ENV_KEYS) {
      if (this.saved[k] === undefined) delete process.env[k];
      else process.env[k] = this.saved[k];
    }
  }

  server() {
    return this.app.getHttpServer();
  }

  /** Заголовки initData бота (помощник по умолчанию). */
  as(
    telegramId: bigint,
    bot: 'assist' | 'qa' = 'assist',
  ): Record<string, string> {
    return {
      'X-Telegram-App': bot,
      'X-Telegram-Init-Data': signInitData({
        botToken: bot === 'assist' ? TEST_ASSIST_TOKEN : TEST_QA_TOKEN,
        userId: Number(telegramId),
      }),
    };
  }
}
