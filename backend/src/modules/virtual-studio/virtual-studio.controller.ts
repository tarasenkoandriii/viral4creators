/**
 * VirtualStudioController — по точной аналогии с `ActorsController`
 * (docs-tz/TZ-Virtualnaya-Studiya-i-AI-Vedushaya.md §5, Этап 1-3):
 * `@Controller('admin/virtual-studio')`, `@UseGuards(AdminSessionGuard)`,
 * каждый метод начинается с `adminPanel.assertOperator(req.userId)`.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
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
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';
import { VirtualStudioService } from './virtual-studio.service';
import {
  CreateAnalysisFragmentDto,
  CreateVideoFragmentDto,
  CreateVoiceFragmentDto,
  CreateVirtualStudioDto,
  GenerateVariantDto,
} from './dto/virtual-studio.dto';

@Controller('admin/virtual-studio')
@UseGuards(AdminSessionGuard)
export class VirtualStudioController {
  constructor(
    private readonly studios: VirtualStudioService,
    private readonly adminPanel: AdminPanelService,
  ) {}

  @Get()
  async list(@Req() req: AdminAuthenticatedRequest) {
    await this.adminPanel.assertOperator(req.userId);
    return this.studios.listStudios();
  }

  @Post()
  async create(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: CreateVirtualStudioDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.studios.createStudio(dto.name, dto.refPrompt, req.userId);
  }

  @Delete(':id')
  async remove(@Req() req: AdminAuthenticatedRequest, @Param('id') id: string) {
    await this.adminPanel.assertOperator(req.userId);
    await this.studios.deleteStudio(id);
    return { ok: true };
  }

  @Get(':id/variants')
  async variants(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.studios.listVariants(id);
  }

  @Post(':id/variants')
  @UseGuards(RateLimitGuard)
  // Тот же лимит, что у дорогих вызовов actors.controller.ts.
  @RateLimit({ name: 'admin-virtual-studio-variant', limit: 5, windowSec: 15 })
  async generateVariant(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: GenerateVariantDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.studios.generateVariant(id, dto.prompt);
  }

  @Post(':id/variants/:variantId/select')
  async selectVariant(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Param('variantId') variantId: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.studios.selectVariant(id, variantId);
  }

  @Delete(':id/variants/:variantId')
  async deleteVariant(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Param('variantId') variantId: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    await this.studios.deleteVariant(id, variantId);
    return { ok: true };
  }

  @Get(':id/fragments')
  async fragments(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.studios.listFragments(id);
  }

  @Post(':id/fragments/video')
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'admin-virtual-studio-video', limit: 5, windowSec: 15 })
  async createVideoFragment(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: CreateVideoFragmentDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.studios.createVideoFragment(id, dto);
  }

  @Post(':id/fragments/voice')
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'admin-virtual-studio-voice', limit: 5, windowSec: 15 })
  async createVoiceFragment(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: CreateVoiceFragmentDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.studios.createVoiceFragment(id, dto);
  }

  @Post(':id/fragments/analysis')
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'admin-virtual-studio-analysis', limit: 5, windowSec: 15 })
  async createAnalysisFragment(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: CreateAnalysisFragmentDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.studios.createAnalysisFragment(id, dto);
  }

  @Get(':id/fragments/:fragmentId/status')
  async fragmentStatus(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Param('fragmentId') fragmentId: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.studios.getFragmentStatus(id, fragmentId);
  }

  @Delete(':id/fragments/:fragmentId')
  async deleteFragment(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Param('fragmentId') fragmentId: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    await this.studios.deleteFragment(id, fragmentId);
    return { ok: true };
  }

  /** Каталог голосов выбранного провайдера (§4.3, §5) — вне `/:id`,
   * не привязан к конкретной студии. */
  @Get('voices')
  async voices(
    @Req() req: AdminAuthenticatedRequest,
    @Query('provider') provider: string,
    @Query('language') language?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    const key = provider === 'elevenlabs' ? 'elevenlabs' : 'resemble';
    return this.studios.listVoices(key, language);
  }

  /** Флаг Hedra (§3.5) — тот же механизм platform settings, что
   * «Озвучка по умолчанию» (admin-voiceover-settings.service.ts), но
   * достаточно простой (одно булево значение), чтобы не заводить
   * отдельный сервис ради него. */
  @Get('settings/hedra-enabled')
  async getHedraEnabled(@Req() req: AdminAuthenticatedRequest) {
    await this.adminPanel.assertOperator(req.userId);
    return { enabled: await this.studios.getHedraEnabled() };
  }

  @Post('settings/hedra-enabled')
  async setHedraEnabled(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: { enabled: boolean },
  ) {
    await this.adminPanel.assertOperator(req.userId);
    await this.studios.setHedraEnabled(!!body.enabled, req.userId);
    return { enabled: await this.studios.getHedraEnabled() };
  }
}
