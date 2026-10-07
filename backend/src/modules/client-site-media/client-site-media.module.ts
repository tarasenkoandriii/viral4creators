import { Module } from '@nestjs/common';
import { SitesInternalModule } from '../sites-internal/sites-internal.module';
import { AssistLinkService } from './assist-link.service';
import { ClientSiteMediaController } from './client-site-media.controller';
import { ClientSiteMediaService } from './client-site-media.service';
import { LandingVideosService } from './landing-videos.service';

/**
 * Обучалка генератора → ИИ-помощник сайта (Э6 помощника): привязка
 * черновика к сайту помощника, ролики сайта и карта интерфейса — по
 * внутреннему API sites-backend (HMAC, `SitesInternalModule`, без DSN
 * `site_*`). Берут его модуль обучалки (раунды, удаление черновика) и
 * раннер (ролик собран) — сам он ни от одного из них не зависит.
 */
@Module({
  imports: [SitesInternalModule],
  controllers: [ClientSiteMediaController],
  // Э-С Ш5: ролики штатной обучалки → сайт тенанта лендинга (тот же канал).
  // W7: привязка существующего черновика из визарда (GET/POST assist-link).
  providers: [ClientSiteMediaService, LandingVideosService, AssistLinkService],
  exports: [ClientSiteMediaService, LandingVideosService],
})
export class ClientSiteMediaModule {}
