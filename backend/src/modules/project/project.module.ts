import { Module } from '@nestjs/common';
import { ProjectController } from './project.controller';
import { ProjectService } from './project.service';
import { StorageModule } from '../storage/storage.module';
import { GreetingBriefModule } from '../greeting-brief/greeting-brief.module';
import { ClientSiteMediaModule } from '../client-site-media/client-site-media.module';

/**
 * ProjectModule — Project / ProductItem catalog
 * (doc/PRODUCT-PROJECT-SPEC.md; Stage 3 of the implementation plan).
 *
 * Distinct from the older `product` module, which is the per-Session
 * "Product Info" step of the generation workflow (POST /sessions/:id/product)
 * — that one stays as-is; Stage 10 (modules/project-session) feeds it from
 * a ProductItem snapshot instead of the hand-typed form. PrismaService comes from the global
 * PrismaModule (app.module.ts), nothing to import here.
 */
@Module({
  // StorageModule — за BlobService: удаление товара/проекта убирает и фото
  // (doc/STORAGE-AUDIT.md, этап 26).
  // GreetingBriefModule — за классификатором регистра «Особого повода»
  // (этап B ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §3.4).
  // ClientSiteMediaModule — W7: удаление проекта обучалки пересылает набор
  // роликов сайта помощника (лист графа: берёт только SitesInternalModule).
  imports: [StorageModule, GreetingBriefModule, ClientSiteMediaModule],
  controllers: [ProjectController],
  providers: [ProjectService],
  exports: [ProjectService],
})
export class ProjectModule {}
