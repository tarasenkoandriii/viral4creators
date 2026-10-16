import { GreetingAvatarBenchmarkService } from './greeting-avatar-benchmark.service';
import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { GreetingModelEvaluationService } from './greeting-model-evaluation.service';
@Controller('admin/ui-snapshot/greeting-evaluation')
@UseGuards(AdminSessionGuard)
export class GreetingModelEvaluationController {
  constructor(
    private readonly admin: AdminPanelService,
    private readonly evaluation: GreetingModelEvaluationService,
    private readonly benchmark: GreetingAvatarBenchmarkService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() req: AdminAuthenticatedRequest) {
    await this.admin.assertOperator(req.userId);
    return this.evaluation.list();
  }
  @Post('benchmark')
  async compareAvatar(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: { sessionId?: unknown },
  ) {
    await this.admin.assertOperator(req.userId);
    return this.benchmark.run(body.sessionId);
  }
  @Post()
  async run(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: { sessionId?: unknown; model?: unknown; retry?: unknown },
  ) {
    await this.admin.assertOperator(req.userId);
    return this.evaluation.run(
      body.sessionId,
      body.model,
      body.retry,
      req.userId,
    );
  }
}
