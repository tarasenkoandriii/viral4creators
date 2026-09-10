import { Module } from '@nestjs/common';
import { BlogController, AdminBlogController } from './blog.controller';
import { BlogService } from './blog.service';
import { BlogGenerationService } from './blog-generation.service';
import { BlogTranslationService } from './blog-translation.service';
import { BlogYoutubeBudgetService } from './blog-youtube-budget.service';
import { YoutubeSearchModule } from '../youtube-search/youtube-search.module';
import { GrokModule } from '../grok/grok.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';

/**
 * BlogModule — блог продукта (doc/TODO.md §II.3-II.5, ТЗ §36, этап 57):
 * генератор черновиков из YouTube-трендов + разбор Gemini
 * (`BlogGenerationService`), очередь перевода через xAI Grok Batch API
 * (`BlogTranslationService`), CRUD/модерация (`BlogService`), публичная
 * витрина + админка (`BlogController`/`AdminBlogController`).
 *
 * `PrismaService` и `AiUsageService` — `@Global()`-модули (см.
 * app.module.ts), явный импорт им не нужен, тот же принцип, что у
 * остальных модулей этого бэкенда.
 */
@Module({
  imports: [YoutubeSearchModule, GrokModule, AdminAuthModule, AdminPanelModule],
  controllers: [BlogController, AdminBlogController],
  providers: [
    BlogService,
    BlogGenerationService,
    BlogTranslationService,
    BlogYoutubeBudgetService,
  ],
  exports: [BlogService, BlogGenerationService, BlogTranslationService],
})
export class BlogModule {}
