/**
 * DemoQualityAdminController — проверка качества демо на вкладке
 * «Видео-контент» админки (doc/TUTORIAL-DEMO-QUALITY-SPEC.md, «Оператор
 * и публикация»).
 *
 * Защита — та же, что у остальных `/api/admin/*`: `AdminSessionGuard`
 * (нет admin-cookie — 401) и `assertOperator` (не оператор — 403) ДО
 * обращения к сервису. Кнопки только ставят проверку в очередь крона —
 * сам анализ идёт в тике `tutorial-assembly-poll`, не в запросе.
 * Одобрение ролика отсюда не меняется (фаза наблюдения).
 */
import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { TutorialDemoQualityService } from './demo-quality.service';
import { DemoQualityCheckRequestDto } from './dto/demo-quality-check.dto';

@Controller('admin/tutorial-demo-quality')
@UseGuards(AdminSessionGuard)
export class DemoQualityAdminController {
  constructor(
    private readonly adminPanel: AdminPanelService,
    private readonly quality: TutorialDemoQualityService,
  ) {}

  /** Последняя проверка роликов страницы: `?assetIds=a,b,c` (до 100). */
  @Get()
  @Header('Cache-Control', 'no-store')
  async latest(
    @Req() req: AdminAuthenticatedRequest,
    @Query('assetIds') assetIds?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.quality.latestForAssets(
      (assetIds ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  /** «Проверить» — один ролик (или его версия темпа). */
  @Post('assets/:id/check')
  async check(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: DemoQualityCheckRequestDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.quality.enqueueByOperator(id, req.userId, dto?.versionId);
  }

  /** «Проверить все одобренные» — с потолком за нажатие. */
  @Post('approved/check')
  async checkApproved(@Req() req: AdminAuthenticatedRequest) {
    await this.adminPanel.assertOperator(req.userId);
    return this.quality.enqueueApproved(req.userId);
  }
}
