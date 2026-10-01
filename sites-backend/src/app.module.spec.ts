/**
 * Граф зависимостей Nest целиком (координатор Э2): каждый модуль этапа
 * подключён в AppModule, и все провайдеры/контроллеры разрешаются. Без
 * базы — compile() создаёт экземпляры, но не подключается (onModuleInit не
 * вызывается). Ловит «агент добавил сервис в конструктор, а модуль его не
 * экспортирует» до деплоя, а не на первом запросе.
 */
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
