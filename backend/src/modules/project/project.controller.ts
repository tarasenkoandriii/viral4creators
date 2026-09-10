/**
 * ProjectController — REST surface of the Project / ProductItem catalog.
 * doc/PRODUCT-PROJECT-SPEC.md §4 (Экраны 1, 2, 4, 5), Stage 3 of the
 * implementation plan.
 *
 *   POST   /projects                      create (Экран 1)
 *   GET    /projects                      list — entry screen before Экран 1
 *   GET    /projects/:id                  full project incl. items + analogs
 *   PATCH  /projects/:id                  title / type / country / manifest link
 *   DELETE /projects/:id
 *   POST   /projects/:id/items            add an item (Экран 2 "добавить ещё")
 *   PATCH  /projects/:id/items/:itemId    description / price (Экраны 4, 5)
 *   DELETE /projects/:id/items/:itemId
 *
 * NOT here (own modules): photo upload + analog search (product-analog),
 * voice → text (voice), starting a Session from an item (project-session).
 *
 * All routes sit behind TelegramIdentityGuard — see that file for why a
 * persistent catalog needs an owner while Sessions may stay anonymous.
 * Real routes carry the global /api prefix (main.ts).
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
  Req,
  UseGuards,
} from '@nestjs/common';
import { ProjectService } from './project.service';
import { CreateProjectRequestDto } from './dto/create-project-request.dto';
import { UpdateProjectRequestDto } from './dto/update-project-request.dto';
import { ProductItemRequestDto } from './dto/product-item-request.dto';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import {
  ProductItemView,
  ProjectSummaryView,
  ProjectView,
} from '../../common/types/project.types';

@Controller('projects')
@UseGuards(TelegramIdentityGuard)
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Post()
  createProject(
    @Req() req: IdentifiedRequest,
    @Body() dto: CreateProjectRequestDto,
  ): Promise<ProjectView> {
    return this.projectService.createProject(req.telegramUserId, dto);
  }

  @Get()
  listProjects(@Req() req: IdentifiedRequest): Promise<ProjectSummaryView[]> {
    return this.projectService.listProjects(req.telegramUserId);
  }

  @Get(':projectId')
  getProject(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
  ): Promise<ProjectView> {
    return this.projectService.getProject(req.telegramUserId, projectId);
  }

  @Patch(':projectId')
  updateProject(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectRequestDto,
  ): Promise<ProjectView> {
    return this.projectService.updateProject(
      req.telegramUserId,
      projectId,
      dto,
    );
  }

  @Delete(':projectId')
  @HttpCode(204)
  deleteProject(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
  ): Promise<void> {
    return this.projectService.deleteProject(req.telegramUserId, projectId);
  }

  @Post(':projectId/items')
  addItem(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: ProductItemRequestDto,
  ): Promise<ProductItemView> {
    return this.projectService.addItem(req.telegramUserId, projectId, dto);
  }

  @Patch(':projectId/items/:itemId')
  updateItem(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
    @Body() dto: ProductItemRequestDto,
  ): Promise<ProductItemView> {
    return this.projectService.updateItem(
      req.telegramUserId,
      projectId,
      itemId,
      dto,
    );
  }

  @Delete(':projectId/items/:itemId')
  @HttpCode(204)
  deleteItem(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Param('itemId') itemId: string,
  ): Promise<void> {
    return this.projectService.deleteItem(
      req.telegramUserId,
      projectId,
      itemId,
    );
  }
}
