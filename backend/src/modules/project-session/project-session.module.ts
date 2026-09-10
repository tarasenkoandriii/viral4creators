import { Module } from '@nestjs/common';
import {
  ProjectSessionController,
  SessionBrandManifestController,
} from './project-session.controller';
import { ProjectSessionService } from './project-session.service';

/**
 * ProjectSessionModule — the bridge between the Project catalog and the
 * generation workflow (Stage 10). SessionService and PrismaService are
 * both global providers (app.module.ts / PrismaModule), nothing to import.
 */
@Module({
  controllers: [ProjectSessionController, SessionBrandManifestController],
  providers: [ProjectSessionService],
  exports: [ProjectSessionService],
})
export class ProjectSessionModule {}
