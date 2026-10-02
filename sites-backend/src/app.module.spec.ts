/**
 * Граф зависимостей Nest целиком (координатор Э2): каждый модуль этапа
 * подключён в AppModule, и все провайдеры/контроллеры разрешаются. Без
 * базы — compile() создаёт экземпляры, но не подключается (onModuleInit не
 * вызывается). Ловит «агент добавил сервис в конструктор, а модуль его не
 * экспортирует» до деплоя, а не на первом запросе.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

describe('AppModule', () => {
  it('собирается: все провайдеры и контроллеры разрешаются', async () => {
    const ref = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    expect(ref).toBeDefined();
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
