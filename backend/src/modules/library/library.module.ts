import { Module } from '@nestjs/common';
import {
  AdminLibraryController,
  LibraryController,
  LibraryVideoController,
} from './library.controller';
import { LibraryService } from './library.service';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';

/**
 * Shared library of Gemini analyses — cache + recommendations (spec §21).
 *
 * НАЙДЕНО И ИСПРАВЛЕНО ПОПУТНО (этап 57, между делом при переносе того же
 * паттерна модерации на блог): `AdminLibraryController` (§21.1 — список/
 * правка/удаление в `/admin/library`, уже вызывается из `admin/src/lib/
 * endpoints.ts` и задокументирован в `doc/API.md`/`doc/LOCAL-DEVELOPMENT.md`)
 * существовал в `library.controller.ts`, но никогда не регистрировался ни
 * в одном `@Module`, то есть его маршруты реально отвечали 404 —
 * админ-панель тихо ходила в несуществующий контроллер. `AdminAuthModule`
 * (за `AdminSessionGuard`) и `AdminPanelModule` (за `AdminPanelService.
 * assertOperator`) добавлены в импорты — тот же набор, что уже использует
 * `PublicationModule` для своего админского контроллера.
 */
@Module({
  imports: [AdminAuthModule, AdminPanelModule],
  controllers: [
    LibraryController,
    LibraryVideoController,
    AdminLibraryController,
  ],
  providers: [LibraryService],
  exports: [LibraryService],
})
export class LibraryModule {}
