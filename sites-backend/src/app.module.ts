/**
 * Корневой модуль sites-backend.
 *
 * Каркас Э0: база и здоровье. Модули site-core (кабинет, сайты, хосты,
 * подтверждение владения), авторизация двух ботов и вебхуки подключаются
 * сюда же своими этапами.
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { TelegramAuthModule } from './modules/telegram-auth/telegram-auth.module';
import { TelegramWebhookModule } from './modules/telegram-webhook/telegram-webhook.module';
import { SiteCoreModule } from './modules/site-core/site-core.module';
import { SiteCrawlModule } from './modules/site-crawl/site-crawl.module';
import { SiteAiModule } from './modules/site-ai/site-ai.module';
import { AssistKnowledgeCoreModule } from './modules/assist-knowledge-core/assist-knowledge-core.module';
import { AssistSiteKnowledgeModule } from './modules/assist-site-knowledge/assist-site-knowledge.module';
import { AssistAdminKnowledgeModule } from './modules/assist-admin-knowledge/assist-admin-knowledge.module';
import { AssistSandboxModule } from './modules/assist-sandbox/assist-sandbox.module';
import { AssistSiteChatModule } from './modules/assist-site-chat/assist-site-chat.module';
import { AssistSiteSetupModule } from './modules/assist-site-setup/assist-site-setup.module';
import { AssistWidgetModule } from './modules/assist-widget/assist-widget.module';
import { AssistSiteHandoffModule } from './modules/assist-site-handoff/assist-site-handoff.module';
import { AssistSiteLearningModule } from './modules/assist-site-learning/assist-site-learning.module';
import { AssistAnalyticsModule } from './modules/assist-analytics/assist-analytics.module';
import { AssistDigestModule } from './modules/assist-digest/assist-digest.module';
import { AssistBillingModule } from './modules/assist-billing/assist-billing.module';
import { PlatformAdminModule } from './modules/platform-admin/platform-admin.module';
import { InternalSitesModule } from './modules/internal-sites/internal-sites.module';
import { AssistSiteVoiceModule } from './modules/assist-site-voice/assist-site-voice.module';

@Module({
  imports: [
    PrismaModule,
    HealthModule,
    // Глобальный гвард двух ботов: маршрут без @AllowApps/@PublicRoute закрыт.
    TelegramAuthModule,
    TelegramWebhookModule,
    // Ядро: кабинет, сайты, хосты, подтверждение владения, крон перепроверки.
    SiteCoreModule,
    // Э1 «Знания» (контракт /tmp/k/CONTRACT-E1.md): обход (общий с QA), ИИ,
    // нейтральное ядро знаний, два раздельных режима, песочница.
    SiteCrawlModule,
    SiteAiModule,
    AssistKnowledgeCoreModule,
    AssistSiteKnowledgeModule,
    AssistAdminKnowledgeModule,
    AssistSandboxModule,
    // Э2 «MVP: виджет режима „Сайт“» (контракт /tmp/k/CONTRACT-E2.md):
    // конвейер ответа, публичный виджет и лендинг, кабинет вида/персоны.
    AssistSiteChatModule,
    AssistWidgetModule,
    AssistSiteSetupModule,
    // Э3 «Передача человеку, сценарии, аналитика, обучение» (контракт
    // /tmp/k/CONTRACT-E3.md): передача в Telegram, обучение на диалогах,
    // цели и статистика, утренняя сводка и отчёт недели.
    AssistSiteHandoffModule,
    AssistSiteLearningModule,
    AssistAnalyticsModule,
    AssistDigestModule,
    // Э4 «Тарифы и оплата»: тариф кабинета, счётчик единиц, Stars/WayForPay,
    // крон продления; внутренний API вкладки «Помощник» админки платформы.
    AssistBillingModule,
    PlatformAdminModule,
    // Э-С Ш1 (П-С3, П-Т1): внутренний API обучалки генератора — режим A/B
    // по статусу хоста и регистрация хоста, HMAC с меткой времени и id.
    InternalSitesModule,
    // Э5 «Голос»: микрофон и озвучка виджета (Soniox), кабинет голоса.
    AssistSiteVoiceModule,
  ],
})
export class AppModule {}
