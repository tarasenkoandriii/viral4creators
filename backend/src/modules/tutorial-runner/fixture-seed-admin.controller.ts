/**
 * FixtureSeedAdminController — тот же приём, что
 * `TutorialScenarioAdminController`/`TutorialVideoAdminController` (см.
 * их доккомментарии): собственный контроллер внутри фиче-модуля.
 *
 * Один эндпоинт, этап 105: раньше единственным способом завести/обновить
 * фикстурного пользователя (§3.3 ТЗ) был ручной CLI-запуск
 * `scripts/seed-fixture-user.ts` с прод DATABASE_URL — недоступно
 * оператору без доступа к серверу/CI. Эта кнопка делает то же самое
 * (`seedFixtureUser()`, `fixture-seed.ts`) через уже подключённый
 * `PrismaService` работающего процесса — второй раз указывать
 * DATABASE_URL не нужно, он у процесса уже есть.
 *
 * `FIXTURE_TELEGRAM_ID` берётся из окружения, НЕ из тела запроса —
 * сознательно: это не «создать тестового пользователя с любым id по
 * запросу оператора», а «завести именно ТОГО фикстурного пользователя,
 * которого ждут регресс-раннер и cron `tutorial-scenario-run`» (тот же
 * id, что читает `fixture-token.ts`). Без этой переменной действие
 * бессмысленно — 400, а не молчаливое создание случайной записи.
 */
import {
  BadRequestException,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { PrismaService } from '../../prisma/prisma.service';
import { seedFixtureUser } from './fixture-seed';

@Controller('admin/tutorial-runner')
@UseGuards(AdminSessionGuard)
export class FixtureSeedAdminController {
  constructor(
    private readonly adminPanel: AdminPanelService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('seed-fixture-user')
  async seedFixtureUser(@Req() req: AdminAuthenticatedRequest) {
    await this.adminPanel.assertOperator(req.userId);
    const telegramId = process.env.FIXTURE_TELEGRAM_ID?.trim();
    if (!telegramId) {
      throw new BadRequestException(
        'FIXTURE_TELEGRAM_ID не задан в окружении — задайте его (см. вкладку «Настройки», группа «Обучалка») и повторите.',
      );
    }
    return seedFixtureUser(this.prisma, telegramId);
  }
}
