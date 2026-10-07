import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { AiUsageModule } from '../ai-usage/ai-usage.module';
import { PersonaController } from './persona.controller';
import { PersonaService } from './persona.service';
import { PersonaSharesService } from './persona-shares.service';
import { PERSONA_SHARES_LOOKUP } from './persona-look-generator';
// F: образы, квота, фраза согласия голоса (persona-looks*).
import { ImageSketchModule } from '../image-sketch/image-sketch.module';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { PersonaLooksController } from './persona-looks.controller';
import { PersonaLooksService } from './persona-looks.service';
import { PERSONA_LOOK_GENERATOR } from './persona-look-generator';
// Оператор снимает отметку «младше 18» (В-4, заход 8).
import { AdminPanelModule } from '../admin-panel/admin-panel.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';
import { PersonaAdminController } from './persona-admin.controller';

/**
 * Режим «Я в кадре» (ТЗ Greeting 2.0 §4). Лист графа: ничего из
 * соседних фич не импортирует — генератор образов F и список страниц G
 * подключаются DI-токенами (`persona-look-generator.ts`), голос персоны
 * удаляется через `ModuleRef`. Так F и G могут импортировать этот
 * модуль (за `PersonaService.requireVerifiedPersona`) без цикла.
 * Крону хранения (`CronModule`) нужен `PersonaService` — отсюда export.
 *
 * `AdminPanelModule`/`AdminAuthModule` — за `assertOperator` и
 * `AdminSessionGuard` контроллера отметки «младше 18»
 * (`persona-admin.controller.ts`). Цикла нет: админка этот модуль не
 * импортирует (тот же приём, что у `ActorsModule`).
 */
@Module({
  // ImageSketchModule — за `SketchGeneratorService` (вызов модели картинок
  // образа); он не импортирует этот модуль, цикла нет.
  imports: [
    StorageModule,
    AiUsageModule,
    ImageSketchModule,
    AdminPanelModule,
    AdminAuthModule,
  ],
  controllers: [
    PersonaController,
    PersonaLooksController,
    PersonaAdminController,
  ],
  providers: [
    PersonaService,
    PersonaLooksService,
    PlatformSettingsService,
    { provide: PERSONA_LOOK_GENERATOR, useExisting: PersonaLooksService },
    // E: страницы с персоной для DELETE /personas/me (кнопка «снять»).
    PersonaSharesService,
    { provide: PERSONA_SHARES_LOOKUP, useExisting: PersonaSharesService },
  ],
  exports: [PersonaService],
})
export class PersonaModule {}
