/**
 * AnalysisSelectionService — keep/drop over scenes and extras (spec §19,
 * Stage 24). Stored in Session.data.analysisSelection; ids are validated
 * against the current analysis so a stale client cannot drop a scene that
 * no longer exists. GET returns the resolved view (every row + active).
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SessionService } from '../../common/session.service';
import { AnalysisSelection } from '../../common/types/analysis.types';
import {
  ExtraSelectionRow,
  resolveSelection,
  SceneSelectionRow,
  selectableIds,
} from '../../common/analysis-selection';
import { SESSION_NOT_FOUND } from '../../common/user-facing-errors';
import { ANALYSIS_ITEM_UNKNOWN } from './analysis-errors';

export interface AnalysisSelectionView {
  scenes: SceneSelectionRow[];
  extras: ExtraSelectionRow[];
  updatedAt: string | null;
}

@Injectable()
export class AnalysisSelectionService {
  private readonly logger = new Logger(AnalysisSelectionService.name);

  constructor(private readonly sessions: SessionService) {}

  async get(sessionId: string): Promise<AnalysisSelectionView> {
    const session = await this.load(sessionId);
    return {
      ...resolveSelection(session.videoAnalysis, session.analysisSelection),
      updatedAt: session.analysisSelection?.updatedAt ?? null,
    };
  }

  async put(
    sessionId: string,
    input: { droppedScenes: string[]; droppedExtras: string[] },
  ): Promise<AnalysisSelectionView> {
    const session = await this.load(sessionId);
    const known = selectableIds(session.videoAnalysis);
    for (const id of input.droppedScenes) {
      if (!known.scenes.has(id)) {
        this.logger.warn(`сессия ${sessionId}: сцены ${id} нет в разборе`);
        throw new BadRequestException(ANALYSIS_ITEM_UNKNOWN);
      }
    }
    for (const id of input.droppedExtras) {
      if (!known.extras.has(id)) {
        this.logger.warn(
          `сессия ${sessionId}: группы массовки ${id} нет в разборе`,
        );
        throw new BadRequestException(ANALYSIS_ITEM_UNKNOWN);
      }
    }
    const selection: AnalysisSelection = {
      droppedScenes: [...new Set(input.droppedScenes)],
      droppedExtras: [...new Set(input.droppedExtras)],
      updatedAt: new Date().toISOString(),
    };
    await this.sessions.updateSession(sessionId, {
      analysisSelection: selection,
    });
    return {
      ...resolveSelection(session.videoAnalysis, selection),
      updatedAt: selection.updatedAt,
    };
  }

  private async load(sessionId: string) {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(SESSION_NOT_FOUND);
    return session;
  }
}
