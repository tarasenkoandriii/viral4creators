/**
 * RelevanceService — "стоит ли клонировать этот референс под этот товар"
 * (doc/PRODUCT-PROJECT-SPEC.md §18.3, Stage 23).
 *
 * One Gemini text call over what the two earlier calls already produced
 * (product audience from the photo, reference audience + promoted product
 * from the video analysis). Cheap — no media — so it can be re-run after
 * the user edits the product's audience or description. The result lives
 * in Session.data.relevance and, unless the user switches it off, feeds
 * the prompt writer as an AUDIENCE FIT section (relevanceBriefText).
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { createGeminiClient } from '../../common/gemini-client';
import { v4 as uuidv4 } from 'uuid';
import { SessionService } from '../../common/session.service';
import { Session } from '../../common/types/session.types';
import { AnalysisStatus } from '../../common/types/analysis.types';
import { RelevanceState } from '../../common/types/relevance.types';
import { parseRelevanceResponse, relevancePrompt } from './relevance-response';
import { PlanService } from '../plan/plan.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { GEMINI_MODEL } from '../../common/gemini-model';
import { languageNameForLocale, normalizeLocale } from '../../common/locale';

const MODEL = GEMINI_MODEL;

@Injectable()
export class RelevanceService {
  private readonly logger = new Logger(RelevanceService.name);
  private readonly genai: GoogleGenAI;

  constructor(
    private readonly sessions: SessionService,
    private readonly plans: PlanService,
    private readonly aiUsage: AiUsageService,
  ) {
    this.genai = createGeminiClient();
  }

  async get(sessionId: string): Promise<RelevanceState> {
    const session = await this.load(sessionId);
    return session.relevance ?? emptyState();
  }

  /** Needs a finished analysis and a product; everything else is optional and reported in `inputs`. */
  async run(sessionId: string): Promise<RelevanceState> {
    const session = await this.load(sessionId);
    // §23: проверка релевантности — от Standard и выше.
    await this.plans.assertCanSpendUser(session.userId ?? null, {
      projectId: session.projectId ?? null,
    }); // §25.3, §26.4
    await this.plans.assertUser(session.userId ?? null, 'relevance');
    const analysis = session.videoAnalysis;
    if (!analysis || analysis.status !== AnalysisStatus.COMPLETE) {
      throw new BadRequestException(
        'Relevance needs a completed video analysis first',
      );
    }
    const product = session.productInformation;
    if (!product?.productName && !product?.productDescription) {
      throw new BadRequestException(
        'Relevance needs the product name or description first',
      );
    }
    const locale = normalizeLocale(session.locale);
    const prompt = relevancePrompt(
      product,
      analysis,
      languageNameForLocale(locale),
    );
    this.logger.log(`Relevance call for session ${sessionId}`);
    const res = await this.genai.models.generateContent({
      model: MODEL,
      contents: [{ text: prompt }],
      config: { responseMimeType: 'application/json' },
    });
    await this.aiUsage.recordGemini(res, {
      operation: 'relevance',
      model: MODEL,
      sessionId,
    });
    const report = parseRelevanceResponse(
      res.text ?? '',
      {
        reportId: uuidv4(),
        now: new Date(),
        inputs: {
          productAudience: !!product.audience,
          videoAudience: !!analysis.audience,
          promotedProduct: !!analysis.promotedProduct,
        },
      },
      locale,
    );
    const state: RelevanceState = {
      report,
      useInPrompt: session.relevance?.useInPrompt ?? true,
      updatedAt: new Date().toISOString(),
    };
    await this.sessions.updateSession(sessionId, { relevance: state });
    return state;
  }

  async update(
    sessionId: string,
    useInPrompt: boolean,
  ): Promise<RelevanceState> {
    const session = await this.load(sessionId);
    const state: RelevanceState = {
      ...(session.relevance ?? emptyState()),
      useInPrompt,
      updatedAt: new Date().toISOString(),
    };
    await this.sessions.updateSession(sessionId, { relevance: state });
    return state;
  }

  private async load(sessionId: string): Promise<Session> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    return session;
  }
}

export function emptyState(): RelevanceState {
  return { report: null, useInPrompt: true, updatedAt: '' };
}
