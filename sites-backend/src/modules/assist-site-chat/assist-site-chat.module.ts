/**
 * Конвейер ответа виджета «Сайта» (Э2, W3): промпт, источники, действия,
 * пост-фильтр, маскирование, бюджет и квота, рубильники, кэш, лиды,
 * ретенция, eval. Режим «Сайт» (правила графа site↛admin и
 * `chat-public-db`: вне папки system/ — только AssistPublicDb).
 */
import { Module } from '@nestjs/common';
import { AssistKnowledgeCoreModule } from '../assist-knowledge-core/assist-knowledge-core.module';
import { SiteAiModule } from '../site-ai/site-ai.module';
import { DialogQuota, SiteBudget } from './budget';
import { SiteChatModel } from './chat-model';
import { SiteLeadsService } from './leads.service';
import { PersonaGate } from './persona-gate';
import { PublicSiteSearch } from './public-search';
import { SemanticCache } from './semantic-cache';
import { SiteAnswerer } from './site-answerer';
import { SiteChatService } from './site-chat.service';
import { AssistBudgetSweepController } from './system/budget-sweep.controller';
import { ChatRetention } from './system/chat-retention.service';
import { LeadDelivery } from './system/lead-delivery.service';
import { PersonaGateRunner } from './system/persona-gate.runner';

@Module({
  imports: [SiteAiModule, AssistKnowledgeCoreModule],
  controllers: [AssistBudgetSweepController],
  providers: [
    SiteChatService,
    SiteChatModel,
    SiteAnswerer,
    PublicSiteSearch,
    SiteBudget,
    DialogQuota,
    SemanticCache,
    SiteLeadsService,
    PersonaGate,
    PersonaGateRunner,
    LeadDelivery,
    ChatRetention,
  ],
  exports: [
    SiteChatService,
    SemanticCache,
    SiteLeadsService,
    PersonaGate,
    ChatRetention,
    LeadDelivery,
  ],
})
export class AssistSiteChatModule {}
