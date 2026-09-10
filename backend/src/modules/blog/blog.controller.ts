/**
 * BlogController — публичная витрина (этап 58 её вызывает; API готов
 * сейчас) + AdminBlogController — модерация (doc/TODO.md §II.3, ТЗ §36),
 * тот же паттерн, что AdminLibraryController/PublicationController:
 * AdminSessionGuard + AdminPanelService.assertOperator(req.userId) в
 * каждом обработчике.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { BlogService } from './blog.service';
import {
  AdminBlogPostDetail,
  AdminBlogPostPage,
  PublicBlogPostDetail,
  PublicBlogPostPage,
} from './blog.types';
import {
  AdminBlogQueryDto,
  CreateManualBlogPostDto,
  PublicBlogQueryDto,
  RejectBlogPostDto,
  UpdateBlogPostDto,
} from './dto/blog.dto';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';

/** Локаль по умолчанию для публичной витрины — оригинальный язык контента. */
const DEFAULT_LOCALE = 'ru';

@Controller('blog')
export class BlogController {
  constructor(private readonly service: BlogService) {}

  @Get()
  list(@Query() q: PublicBlogQueryDto): Promise<PublicBlogPostPage> {
    return this.service.publicList({
      locale: q.locale ?? DEFAULT_LOCALE,
      category: q.category,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get(':slug')
  get(
    @Param('slug') slug: string,
    @Query('locale') locale?: string,
  ): Promise<PublicBlogPostDetail> {
    if (!slug.trim()) throw new NotFoundException('Blog post not found');
    return this.service.publicGetBySlug(slug, locale ?? DEFAULT_LOCALE);
  }
}

@Controller('admin/blog')
@UseGuards(AdminSessionGuard)
export class AdminBlogController {
  constructor(
    private readonly service: BlogService,
    private readonly adminPanel: AdminPanelService,
  ) {}

  @Get()
  async list(
    @Req() req: AdminAuthenticatedRequest,
    @Query() q: AdminBlogQueryDto,
  ): Promise<AdminBlogPostPage> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.adminList({
      status: q.status,
      category: q.category,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get(':id')
  async get(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<AdminBlogPostDetail> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.adminGet(id);
  }

  @Post()
  async create(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: CreateManualBlogPostDto,
  ): Promise<AdminBlogPostDetail> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.adminCreateManual(req.userId, dto);
  }

  @Patch(':id')
  async update(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateBlogPostDto,
  ): Promise<AdminBlogPostDetail> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.adminUpdate(id, dto);
  }

  @Post(':id/approve')
  async approve(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<AdminBlogPostDetail> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.approve(id, req.userId);
  }

  @Post(':id/reject')
  async reject(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: RejectBlogPostDto,
  ): Promise<AdminBlogPostDetail> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.reject(id, req.userId, dto.reason);
  }

  @Post(':id/publish')
  async publish(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<AdminBlogPostDetail> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.publish(id, req.userId);
  }

  @Post(':id/unpublish')
  async unpublish(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<AdminBlogPostDetail> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.unpublish(id, req.userId);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<void> {
    await this.adminPanel.assertOperator(req.userId);
    return this.service.delete(id);
  }
}
