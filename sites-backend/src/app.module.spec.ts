/**
 * Граф зависимостей Nest целиком (координатор Э2): каждый модуль этапа
 * подключён в AppModule, и все провайдеры/контроллеры разрешаются. Без
 * базы — compile() создаёт экземпляры, но не подключается (onModuleInit не
 * вызывается). Ловит «агент добавил сервис в конструктор, а модуль его не
 * экспортирует» до деплоя, а не на первом запросе.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { GoalWebhookService } from './modules/assist-analytics/goal-webhook.service';
import { AnalyticsRollup } from './modules/assist-analytics/system/analytics-rollup.service';

describe('AppModule', () => {
  it('собирается: все провайдеры и контроллеры разрешаются', async () => {
    const ref = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    expect(ref).toBeDefined();
    await ref.close();
  });

  /**
   * Заход 12, аудит P2-1. Цикл импортов `goal-webhook.service` ↔
   * `analytics-rollup.service` делал `design:paramtypes[2]` равным
   * `undefined`. Nest молча ставил `undefined` в `@Optional()`-параметр:
   * возврат по вебхуку не пересчитывал день заказа. Порядок загрузки — как в
   * проде: сначала AppModule.
   */
  it('GoalWebhookService получает AnalyticsRollup (rollup injected)', async () => {
    const ref = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const hook = ref.get(GoalWebhookService, { strict: false });
    const rollup = ref.get(AnalyticsRollup, { strict: false });
    expect(rollup).toBeInstanceOf(AnalyticsRollup);
    expect((hook as unknown as { rollup?: unknown }).rollup).toBe(rollup);
    await ref.close();
  });

  /**
   * Страж от повторения: у провайдеров и контроллеров приложения нет
   * `undefined` в типах параметров конструктора (признак цикла импортов,
   * который Nest для `@Optional()` не замечает).
   */
  it('нет undefined в design:paramtypes провайдеров и контроллеров', async () => {
    const ref = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const bad: string[] = [];
    for (const mod of ref.get(ModulesContainer).values()) {
      const wrappers = [
        ...mod.providers.values(),
        ...mod.controllers.values(),
        ...mod.injectables.values(),
      ];
      for (const w of wrappers) {
        const t = w.metatype as unknown;
        if (typeof t !== 'function' || w.inject) continue;
        const types = Reflect.getMetadata('design:paramtypes', t) as
          unknown[] | undefined;
        types?.forEach((x, i) => {
          if (x === undefined) bad.push(`${(t as { name: string }).name}#${i}`);
        });
      }
    }
    expect([...new Set(bad)]).toEqual([]);
    await ref.close();
  });
});

/**
 * Э3 (координатор): каждый крон sites-backend/vercel.json обслуживает
 * контроллер `@Controller('cron')` с `@Get('<имя>')` — опечатка в пути
 * крона в проде молча дала бы 404 раз в N минут.
 */
describe('кроны vercel.json ↔ контроллеры', () => {
  it('у каждого крона есть @Get в контроллере cron', () => {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'),
    ) as { crons: Array<{ path: string }> };
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.controller\.ts$/.test(e.name)) {
          const code = fs.readFileSync(full, 'utf8');
          if (code.includes("@Controller('cron')")) sources.push(code);
        }
      }
    };
    walk(__dirname);
    const missing = cfg.crons
      .map((c) => c.path.replace(/^\/cron\//, ''))
      .filter((name) => !sources.some((s) => s.includes(`@Get('${name}')`)));
    expect(cfg.crons.length).toBeGreaterThanOrEqual(11);
    expect(missing).toEqual([]);
  });
});
