/**
 * Помощник сотрудника «Админки» — Э7: 7a (TMA) и 7b (встраивание по
 * employee-JWT, iframe на отдельном origin `wa.`). Знания — только
 * assist_admin_* (AssistAdminKnowledgeModule), инструменты — коннекторы
 * (AssistAdminModeModule). Модули «Сайта» не импортирует (граф admin↛site);
 * публичный код «Сайта» этот модуль не импортирует (site↛admin).
 */
import { Module } from '@nestjs/common';
import { AssistAdminActionsModule } from '../assist-admin-actions/assist-admin-actions.module';
import { AssistAdminKnowledgeModule } from '../assist-admin-knowledge/assist-admin-knowledge.module';
import { AssistAdminModeModule } from '../assist-admin-mode/assist-admin-mode.module';
import { AssistKnowledgeCoreModule } from '../assist-knowledge-core/assist-knowledge-core.module';
import { SiteCoreModule } from '../site-core/site-core.module';
import { AdminAnswerService } from './admin-answer.service';
import { AdminChatService } from './admin-chat.service';
import { AdminEmbedController } from './admin-embed.controller';
import { AdminFrameController } from './admin-frame.controller';
import {
  AdminEmbedProposalsController,
  AdminTmaProposalsController,
} from './admin-proposals.controller';
import { AdminSessionService } from './admin-session.service';
import { AdminTmaChatController } from './admin-tma-chat.controller';
import { AssistAdminRetentionController } from './cron/assist-admin-retention.controller';

@Module({
  imports: [
    SiteCoreModule,
    AssistKnowledgeCoreModule,
    AssistAdminKnowledgeModule,
    AssistAdminModeModule,
    AssistAdminActionsModule,
  ],
  controllers: [
    AdminEmbedController,
    AdminTmaChatController,
    AdminFrameController,
    AssistAdminRetentionController,
    AdminEmbedProposalsController,
    AdminTmaProposalsController,
  ],
  providers: [AdminAnswerService, AdminChatService, AdminSessionService],
  exports: [AdminChatService, AdminSessionService],
})
export class AssistAdminChatModule {}
