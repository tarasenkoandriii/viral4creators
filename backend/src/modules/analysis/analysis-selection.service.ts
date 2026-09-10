/**
 * AnalysisSelectionService — keep/drop over scenes and extras (spec §19,
 * Stage 24). Stored in Session.data.analysisSelection; ids are validated
 * against the current analysis so a stale client cannot drop a scene that
 * no longer exists. GET returns the resolved view (every row + active).
 */

import {
  BadRequestException,
  Injectable,
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

export interface AnalysisSelectionView {
  scenes: SceneSelectionRow[];
  extras: ExtraSelectionRow[];
  updatedAt: string | null;
}

@Injectable()
export class AnalysisSelectionService {
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
        throw new BadRequestException(
          `"${id}" is not a scene of this session's analysis`,
        );
      }
    }
    for (const id of input.droppedExtras) {
      if (!known.extras.has(id)) {
        throw new BadRequestException(
          `"${id}" is not an extras group of this session's analysis`,
        );
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
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    return session;
  }
}
