import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { SitesDb } from './sites-db.service';
import { AssistPublicDb } from './assist-public-db.service';

/**
 * Глобальный: `SitesDb` нужен почти каждому модулю site-core/assist/qa, и
 * импортировать модуль в каждом — шум без пользы (как в backend).
 */
@Global()
@Module({
  // AssistPublicDb — клиент под ролью assist_public, только для публичных
  // маршрутов виджета (ТЗ помощника §4.3-бис, слой 3).
  providers: [PrismaService, SitesDb, AssistPublicDb],
  exports: [PrismaService, SitesDb, AssistPublicDb],
})
export class PrismaModule {}
