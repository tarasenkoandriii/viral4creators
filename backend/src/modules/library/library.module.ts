import { Module } from '@nestjs/common';
import {
  AdminLibraryController,
  LibraryController,
  LibraryVideoController,
} from './library.controller';
import { LibraryService } from './library.service';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { StorageModule } from '../storage/storage.module';

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
 *
 * НАЙДЕНО И ИСПРАВЛЕНО ПОПУТНО (реальный краш на проде, 2026-09-10):
 * `StorageModule` не был в импортах, хотя `LibraryService` уже давно
 * (Stage 26 — копии кадров-превью под собственным префиксом библиотеки,
 * см. её `copyPreviews`) внедряет `BlobService` третьим параметром
 * конструктора. В песочнице `nest build`/тесты (там `BlobService` мокается
 * в спеках самого `LibraryService`, минуя реальный DI-граф Nest) это не
 * ловилось никогда — только настоящий запуск Nest поднимает граф модулей
 * и падает с "Nest can't resolve dependencies of the LibraryService ...
 * BlobService at index [2] is available in the LibraryModule context".
 */
@Module({
  imports: [AdminAuthModule, AdminPanelModule, StorageModule],
  controllers: [
    LibraryController,
    LibraryVideoController,
    AdminLibraryController,
  ],
  providers: [LibraryService],
  exports: [LibraryService],
})
export class LibraryModule {}
