/**
 * Кабинет виджета «Сайта» (Э2, W4): вид, ключи, персона, лиды, предпросмотр,
 * проверка установки. Режим «Сайт» (правило графа: /^assist-site-/ ↛
 * «Админка»). Импортирует чат (PersonaGate — W3) и обход (проверка установки).
 */
import { Module } from '@nestjs/common';
import { AssistSiteChatModule } from '../assist-site-chat/assist-site-chat.module';
import { SiteCoreModule } from '../site-core/site-core.module';
import { SiteCrawlModule } from '../site-crawl/site-crawl.module';
import { InstallCheckService } from './install-check.service';
import { PersonaService } from './persona.service';
import { SiteSetupController } from './site-setup.controller';
import { WidgetSettingsService } from './widget-settings.service';

@Module({
  imports: [SiteCoreModule, SiteCrawlModule, AssistSiteChatModule],
  controllers: [SiteSetupController],
  providers: [WidgetSettingsService, PersonaService, InstallCheckService],
  exports: [WidgetSettingsService],
})
export class AssistSiteSetupModule {}
