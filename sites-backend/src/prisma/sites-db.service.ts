import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TenantScopeError, tenantExtension } from './tenant';

/**
 * Единственная дверь сервисов site-core/assist/qa в базу `sites`.
 *
 *  - `forAccount(accountId)` — обычный путь: кабинет подставляется в
 *    каждый запрос к таблицам кабинета (prisma/tenant.ts);
 *  - `guarded` — клиент, который сам ничего не подставляет, но запрос к
 *    таблице кабинета без явного accountId бросает. Для кода, которому
 *    кабинет приходит внутри запроса (например, по hostId из URL);
 *  - `system(reason)` — сырой клиент для того, что по смыслу НЕ внутри
 *    одного кабинета: крон перепроверки владения по всем хостам, вход
 *    («в каких кабинетах этот telegramId»), отчёты оператора. Причина —
 *    обязательный аргумент: каждое такое место видно грепом и в ревью.
 */
@Injectable()
export class SitesDb {
  readonly guarded;

  constructor(private readonly prisma: PrismaService) {
    this.guarded = prisma.$extends(tenantExtension(null));
  }

  forAccount(accountId: string) {
    if (typeof accountId !== 'string' || accountId === '') {
      throw new TenantScopeError('forAccount: пустой accountId');
    }
    return this.prisma.$extends(tenantExtension(accountId));
  }

  system(reason: string): PrismaService {
    if (typeof reason !== 'string' || reason.trim().length < 3) {
      throw new TenantScopeError(
        'system(): укажите причину доступа мимо тенанта',
      );
    }
    return this.prisma;
  }
}
