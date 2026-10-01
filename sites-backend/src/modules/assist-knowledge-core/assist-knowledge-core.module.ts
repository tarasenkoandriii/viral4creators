/**
 * Нейтральное ядро знаний (правила графа core-neutral и neutral-names):
 * чанкер, хеши, карантин, RRF, хранилище по переданным именам таблиц,
 * ответ по фрагментам, разбор документов, приватный Blob. Таблиц режимов
 * не знает — их передают assist-site-knowledge / assist-admin-knowledge.
 * Владельцы файлов: K2 (индексация/поиск/версии), K3 (answer/, documents/).
 */
import { Module } from '@nestjs/common';
import { SiteAiModule } from '../site-ai/site-ai.module';
import { AnswerEngine } from './answer/answer-engine';
import { KnowledgeBlobStorage } from './documents/blob-storage';

@Module({
  imports: [SiteAiModule],
  providers: [AnswerEngine, KnowledgeBlobStorage],
  exports: [AnswerEngine, KnowledgeBlobStorage, SiteAiModule],
})
export class AssistKnowledgeCoreModule {}
