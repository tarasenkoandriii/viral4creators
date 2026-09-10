/**
 *   GET  /library/recommend?sessionId=…&limit=…   ranked scenarios for this product (§21)
 *   GET  /library/:id                            one entry (facets only)
 *   POST /sessions/:id/video/library {entryId}    take a stored analysis as the reference
 *   GET/PATCH/DELETE /admin/library[/:id]        moderation (§21.1, operators only)
 *
 * No identity required: the library is shared and read-only from outside;
 * the session UUID is the bearer, as everywhere under /sessions (§7.8).
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { LibraryService } from './library.service';
import {
  AdminLibraryEntryView,
  AdminLibraryPage,
  LibraryEntryView,
  LibraryRecommendation,
} from './library.types';
import {
  RecommendQueryDto,
  UpdateLibraryEntryRequestDto,
  UseLibraryEntryRequestDto,
} from './dto/library.dto';
import { VideoAnalysis } from '../../common/types/analysis.types';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';

@Controller('library')
export class LibraryController {
  constructor(private readonly service: LibraryService) {}

  @Get('recommend')
  recommend(@Query() q: RecommendQueryDto): Promise<LibraryRecommendation[]> {
    return this.service.recommend(q.sessionId, q.limit);
  }

  @Get(':entryId')
  get(@Param('entryId') entryId: string): Promise<LibraryEntryView> {
    return this.service.get(entryId);
  }
}

@Controller('sessions/:sessionId/video')
export class LibraryVideoController {
  constructor(private readonly service: LibraryService) {}

  @Post('library')
  use(
    @Param('sessionId') sessionId: string,
    @Body() dto: UseLibraryEntryRequestDto,
  ): Promise<VideoAnalysis> {
    return this.service.applyToSession(sessionId, dto.entryId);
  }
}

/**
 * Модерация библиотеки (§21.1) — AdminSessionGuard + isOperator, как и
 * остальная админка. Скрытие важнее удаления: скрытая запись не
 * рекомендуется и не отдаётся из кеша, но остаётся видна оператору с
 * причиной; удаление стирает след, и источник разберётся заново.
 */
@Controller('admin/library')
@UseGuards(AdminSessionGuard)
export class AdminLibraryController {
  constructor(
    private readonly service: LibraryService,
    private readonly adminPanel: AdminPanelService,
  ) {}

  @Get()
  async list(
    @Req() req: AdminAuthenticatedRequest,
    @Query('visibility') visibility?: string,
    @Query('sourceType') sourceType?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<AdminLibraryPage> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.adminList({
      visibility,
      sourceType,
      q,
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      pageSize: Math.min(
        Math.max(parseInt(pageSize ?? '20', 10) || 20, 1),
        100,
      ),
    });
  }

  @Get(':id')
  async get(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<AdminLibraryEntryView & { analysis: VideoAnalysis | null }> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.adminGet(id);
  }

  @Patch(':id')
  async update(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateLibraryEntryRequestDto,
  ): Promise<AdminLibraryEntryView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.adminUpdate(id, req.userId, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<void> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.adminDelete(id);
  }
}
