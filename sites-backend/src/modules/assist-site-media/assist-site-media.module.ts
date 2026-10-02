/**
 * Видео-ответы и «показать на экране» (Э6, ТЗ §4.9, §4.11, §4.12):
 * публичная часть (`public/` — под assist_public: ролики для промпта и
 * ссылки, карта страницы и сигнал «карта устарела»; её зовут конвейер
 * ответа и маршруты assist-widget) и кабинет экрана «Видео» (`cabinet/` —
 * основная роль). Режим «Сайт» (правило site↛admin); правило
 * `public-zone-e6`: публичный код других модулей берёт отсюда только
 * `public/`, типы, `*-config` и модуль.
 *
 * Запись роликов и карты из обучалки генератора — НЕ здесь: это
 * внутренний API (`internal-sites/site-media.*`, HMAC, лист графа).
 */
import { Module } from '@nestjs/common';
import { SiteCoreModule } from '../site-core/site-core.module';
import { SiteVideosController } from './cabinet/site-videos.controller';
import { SiteVideosService } from './cabinet/site-videos.service';

@Module({
  imports: [SiteCoreModule],
  controllers: [SiteVideosController],
  providers: [SiteVideosService],
})
export class AssistSiteMediaModule {}
