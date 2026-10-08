/**
 * Заход 10: порты к очереди воркера подключаются в НАСТОЯЩЕМ графе Nest —
 * обход (`SiteCrawlService.spaRender`, Ш3 (20)) и монитор Т-4
 * (`VoiceMonitorService.autotest`, №29) живут в других модулях и
 * находятся через `ModuleRef` (без правки модулей и правил графа). Без
 * базы: `compile()` создаёт экземпляры, хук инициализации зовётся вручную.
 */
import { Test } from '@nestjs/testing';
import { AppModule } from '../../app.module';
import { VoiceMonitorService } from '../assist-site-voice-control/system/voice-monitor.service';
import { BrowserJobHandlers } from '../browser-jobs/job-handlers';
import { SiteCrawlService } from '../site-crawl/crawl.service';
import { VoiceMapWorkerService } from './voice-map-worker.service';

describe('порты воркера в графе приложения (заход 10)', () => {
  it('рендер SPA и Т-3 по расписанию подключены, обработчик voice-autotest зарегистрирован', async () => {
    const ref = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    try {
      const crawl = ref.get(SiteCrawlService, { strict: false });
      const monitor = ref.get(VoiceMonitorService, { strict: false });
      expect(crawl.spaRender).toBeNull();
      expect(monitor.autotest).toBeNull();
      ref.get(VoiceMapWorkerService, { strict: false }).onModuleInit();
      expect(crawl.spaRender).not.toBeNull();
      expect(monitor.autotest).not.toBeNull();
      const handlers = ref.get(BrowserJobHandlers, { strict: false });
      expect(handlers.get('voice-autotest')).not.toBeNull();
      expect(handlers.get('voice-map-snapshot')).not.toBeNull();
    } finally {
      await ref.close();
    }
  });
});
