/**
 * Передача человеку в Telegram (Э3, агент H; контракт /tmp/k/CONTRACT-E3.md):
 * приём от посетителя (public/, только AssistPublicDb), рассылка карточек,
 * «Взять», ответы реплаем/из TMA, перевод, черновик, сводка, таймауты и
 * напоминания (system/, основная роль), бот (bot/), кабинет (cabinet/).
 * Режим «Сайт» (правило графа site↛admin).
 */
import { Module } from '@nestjs/common';
import { AssistAnalyticsModule } from '../assist-analytics/assist-analytics.module';
import { AssistKnowledgeCoreModule } from '../assist-knowledge-core/assist-knowledge-core.module';
import { SiteBudget } from '../assist-site-chat/budget';
import { AssistSiteKnowledgeModule } from '../assist-site-knowledge/assist-site-knowledge.module';
import { AssistSiteLearningModule } from '../assist-site-learning/assist-site-learning.module';
import { SiteAiModule } from '../site-ai/site-ai.module';
import { SiteCoreModule } from '../site-core/site-core.module';
import { AssistBotUpdates } from './bot/assist-bot-updates.service';
import { HandoffCabinetController } from './cabinet/handoff-cabinet.controller';
import {
  ConversationsService,
  HandoffSettingsService,
} from './cabinet/conversations.service';
import { HandoffIntake } from './public/handoff-intake.service';
import { HandoffAi } from './system/handoff-ai';
import { HandoffDispatcher } from './system/handoff-dispatcher.service';
import { HandoffOperatorActions } from './system/handoff-operator.service';
import { AssistHandoffTickController } from './system/handoff-tick.controller';

@Module({
  imports: [
    SiteCoreModule,
    SiteAiModule,
    AssistSiteKnowledgeModule,
    AssistSiteLearningModule,
    // H: черновик — AnswerEngine (как мастер Э2); «покупатель проверен» —
    // IntegrationsService.verifyUserHash (A). Ни один не импортирует этот модуль.
    AssistKnowledgeCoreModule,
    AssistAnalyticsModule,
  ],
  controllers: [HandoffCabinetController, AssistHandoffTickController],
  providers: [
    HandoffIntake,
    HandoffDispatcher,
    HandoffOperatorActions,
    HandoffAi,
    AssistBotUpdates,
    ConversationsService,
    HandoffSettingsService,
    // Деньги дня сайта+платформы (без зависимостей) — свой экземпляр:
    // модуль чата импортирует этот модуль, обратный импорт дал бы цикл.
    SiteBudget,
  ],
  exports: [
    HandoffIntake,
    HandoffDispatcher,
    AssistBotUpdates,
    // H: ответ/взять — общая логика бота и TMA (тесты маршрутов и W).
    HandoffOperatorActions,
  ],
})
export class AssistSiteHandoffModule {}
