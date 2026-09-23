/**
 * VideoAuditService — spec §11 (Stage 16): optional Gemini check of the
 * generated video for artefacts, a brief for the user, and a revised
 * prompt that goes back into the existing prompt editor → existing
 * generation flow. No new external service: the same Gemini key and the
 * same Files-API path AnalysisService uses for uploaded references.
 *
 * Soft iteration cap (§11.1): `appliedFixes` counts how many audit fixes
 * were pushed into the prompt; past AUDIT_AUTO_ITERATIONS_LIMIT the
 * response carries `overLimit: true` and the UI warns — nothing here
 * refuses.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { GoogleGenAI, Part } from '@google/genai';
import { createGeminiClient } from '../../common/gemini-client';
import { v4 as uuidv4 } from 'uuid';
import { SessionService } from '../../common/session.service';
import { BlobService } from '../storage/blob.service';
import { GeminiFilesService } from '../analysis/gemini-files.service';
import { loadConfiguration } from '../../config/configuration';
import { Session } from '../../common/types/session.types';
import { GenerationStatus } from '../../common/types/generation.types';
import { GenerationPrompt } from '../../common/types/prompt.types';
import {
  SoundCheck,
  VideoAudit,
  VideoAuditState,
} from '../../common/types/audit.types';
import {
  auditPrompt,
  manualFixPrompt,
  parseAuditResponse,
  parseManualFixResponse,
} from './audit-response';
import {
  appendSoundCheck,
  parseSoundCheckResponse,
  soundCheckPrompt,
} from '../../common/sound-check';
import { ApplyFixRequestDto, RunAuditRequestDto } from './dto/audit.dto';
import { PlanService } from '../plan/plan.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { GEMINI_MODEL } from '../../common/gemini-model';
import { languageNameForLocale, normalizeLocale } from '../../common/locale';

/** "Пользователь указал: …" (этап 59) — короткая пятиязычная подпись
 * перед фразой пользователя, когда сама модель не дала своего summary. */
const USER_REPORTED_PREFIX: Readonly<Record<string, string>> = {
  ru: 'Пользователь указал',
  uk: 'Користувач вказав',
  en: 'User reported',
  de: 'Nutzer meldete',
  es: 'El usuario informó',
};

const MODEL = GEMINI_MODEL;
const MAX_HISTORY = 20;

export interface AuditStateView {
  history: VideoAudit[];
  appliedFixes: number;
  limit: number;
  /** appliedFixes >= limit — the UI shows a cost warning before the next round. */
  overLimit: boolean;
}

export interface ApplyFixResult {
  prompt: GenerationPrompt;
  state: AuditStateView;
}

/** М-2.5: TTL замка аудита — с запасом сверх одного Gemini-вызова. */
const AUDIT_CLAIM_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class VideoAuditService {
  private readonly logger = new Logger(VideoAuditService.name);
  private readonly genai: GoogleGenAI;
  private readonly limit: number;

  constructor(
    private readonly plans: PlanService,
    private readonly sessions: SessionService,
    private readonly blob: BlobService,
    private readonly geminiFiles: GeminiFilesService,
    private readonly aiUsage: AiUsageService,
  ) {
    this.genai = createGeminiClient();
    this.limit = loadConfiguration().videoAudit.autoIterationsLimit;
  }

  async getState(sessionId: string): Promise<AuditStateView> {
    const session = await this.load(sessionId);
    return this.view(session.videoAudit);
  }

  /** GET /sessions/:id/sound-check (этап 73). */
  async getSoundCheckState(
    sessionId: string,
  ): Promise<{ history: SoundCheck[] }> {
    const session = await this.load(sessionId);
    return session.soundCheck ?? { history: [] };
  }

  /** POST /sessions/:id/audit */
  async run(
    sessionId: string,
    dto: RunAuditRequestDto,
  ): Promise<AuditStateView> {
    // М-2.5 седьмого аудита: замок на платный вызов + перечитывание
    // истории под ним (см. `runGuarded`).
    return this.runGuarded(sessionId, 'audit', () =>
      this.runUnlocked(sessionId, dto),
    );
  }

  /** Замок вида работы вокруг платного Gemini-вызова; занятый замок —
   * 409, как у `generateVideo`. */
  private async runGuarded<T>(
    sessionId: string,
    kind: 'audit' | 'sound-check',
    fn: () => Promise<T>,
  ): Promise<T> {
    const claimed = await this.sessions.claimWork(
      sessionId,
      kind,
      AUDIT_CLAIM_TTL_MS,
    );
    if (!claimed) {
      throw new ConflictException(
        'Проверка уже идёт — дождитесь её результата',
      );
    }
    try {
      return await fn();
    } finally {
      await this.sessions.releaseWork(sessionId, kind);
    }
  }

  private async runUnlocked(
    sessionId: string,
    dto: RunAuditRequestDto,
  ): Promise<AuditStateView> {
    const session = await this.load(sessionId);
    // §23: аудит ролика — от Standard и выше.
    await this.plans.assertCanSpendUser(session.userId ?? null, {
      projectId: session.projectId ?? null,
    }); // §25.3, §26.4
    await this.plans.assertUser(session.userId ?? null, 'audit');
    const video = session.generatedVideo;
    if (!video || video.status !== GenerationStatus.COMPLETE) {
      throw new BadRequestException(
        'No completed video to audit — generate the video first',
      );
    }
    // Пока постобработка идёт, готового файла ещё нет, а исходник уже
    // не тот, что увидит пользователь: честнее попросить подождать, чем
    // потратить платный вызов на устаревший кадр.
    if (video.postStatus === 'pending') {
      throw new BadRequestException(
        'Ролик ещё обрабатывается — дождитесь готовой версии и проверьте её',
      );
    }
    const promptText = session.generationPrompt?.finalText;
    if (!promptText) {
      throw new BadRequestException('Session has no prompt to revise');
    }
    // §35.5 (этап 59): отчёт читает селлер — на его UI-локали, а не на
    // языке диалога ролика (тот остаётся в promptFix.suggestedText нетронутым).
    const locale = normalizeLocale(session.locale);
    const languageName = languageNameForLocale(locale);

    const issue = dto.issue?.trim();
    const audit: VideoAudit = {
      auditId: uuidv4(),
      generatedVideoId: video.generatedVideoId,
      source: issue ? 'user' : 'gemini',
      requestedAt: new Date(),
      completedAt: null,
      status: 'complete',
      verdict: 'unknown',
      summary: '',
      issues: [],
      promptFix: null,
      promptText,
    };

    try {
      if (issue) {
        const parsed = parseManualFixResponse(
          await this.askText(
            manualFixPrompt(promptText, issue, languageName),
            sessionId,
          ),
        );
        // The user IS the detector (§11.3): one issue, theirs; the model only
        // supplied the fix, so "clean" makes no sense here.
        audit.verdict = 'issues';
        audit.issues = [
          {
            id: 'a1',
            severity: 'medium',
            category: 'user',
            description: issue,
            timecode: null,
          },
        ];
        audit.summary =
          parsed.summary ||
          `${USER_REPORTED_PREFIX[locale] ?? USER_REPORTED_PREFIX.ru}: ${issue}`;
        audit.promptFix = parsed.promptFix;
      } else {
        // §11 (этап 39, А-2.9): смотреть надо ТОТ файл, который увидит
        // пользователь. После постобработки (§15.4/§16.1) готовый ролик
        // лежит по `postPathname`, а `pathname` — это исходник Veo: у
        // него другой кадр и, в режимах со своей озвучкой, другая
        // звуковая дорожка. Аудит по исходнику судил бы о ролике,
        // которого не существует, — а у него есть категория `audio`.
        const auditedPathname = video.postPathname ?? video.pathname;
        const parsed = parseAuditResponse(
          await this.askVideo(
            auditedPathname,
            auditPrompt(promptText, languageName),
            sessionId,
          ),
          locale,
        );
        audit.verdict = parsed.verdict;
        audit.summary = parsed.summary;
        audit.issues = parsed.issues;
        audit.promptFix = parsed.promptFix;
      }
    } catch (e) {
      audit.status = 'failed';
      audit.error = e instanceof Error ? e.message : String(e);
      this.logger.error(
        `Audit failed for session ${sessionId}: ${audit.error}`,
      );
    }
    audit.completedAt = new Date();

    // История перечитывается перед записью: за время Gemini-вызова
    // её мог дополнить applyFix или параллельный тик.
    const fresh = await this.sessions.getSession(sessionId);
    const state = this.append(fresh?.videoAudit ?? session.videoAudit, audit);
    await this.sessions.updateSession(sessionId, { videoAudit: state });
    return this.view(state);
  }

  /**
   * POST /sessions/:id/sound-check (этап 73) — отдельный от `run()` выше
   * Gemini-вызов: не ищет технические дефекты, а судит только реализм
   * голоса («звучит как человек» / «звучит как TTS»). Тот же гейт по
   * тарифу и то же требование готового ролика, что у обычного аудита —
   * это тоже платный вызов Gemini на тот же файл.
   */
  async runSoundCheck(sessionId: string): Promise<{ history: SoundCheck[] }> {
    return this.runGuarded(sessionId, 'sound-check', () =>
      this.runSoundCheckUnlocked(sessionId),
    );
  }

  private async runSoundCheckUnlocked(
    sessionId: string,
  ): Promise<{ history: SoundCheck[] }> {
    const session = await this.load(sessionId);
    await this.plans.assertCanSpendUser(session.userId ?? null, {
      projectId: session.projectId ?? null,
    });
    await this.plans.assertUser(session.userId ?? null, 'audit');
    const video = session.generatedVideo;
    if (!video || video.status !== GenerationStatus.COMPLETE) {
      throw new BadRequestException(
        'No completed video to check — generate the video first',
      );
    }
    if (video.postStatus === 'pending') {
      throw new BadRequestException(
        'Ролик ещё обрабатывается — дождитесь готовой версии и проверьте её',
      );
    }
    const locale = normalizeLocale(session.locale);
    const languageName = languageNameForLocale(locale);
    // Тот же файл, что видит пользователь — см. комментарий в run() про
    // postPathname vs pathname.
    const auditedPathname = video.postPathname ?? video.pathname;

    const check: SoundCheck = {
      checkId: uuidv4(),
      subject: 'veo',
      requestedAt: new Date(),
      completedAt: null,
      status: 'complete',
      verdict: 'unknown',
      summary: '',
      notes: [],
    };
    try {
      const parsed = parseSoundCheckResponse(
        await this.askVideo(
          auditedPathname,
          soundCheckPrompt(languageName),
          sessionId,
        ),
        locale,
      );
      check.verdict = parsed.verdict;
      check.summary = parsed.summary;
      check.notes = parsed.notes;
    } catch (e) {
      check.status = 'failed';
      check.error = e instanceof Error ? e.message : String(e);
      this.logger.error(
        `Sound check failed for session ${sessionId}: ${check.error}`,
      );
    }
    check.completedAt = new Date();

    const fresh = await this.sessions.getSession(sessionId);
    const state = appendSoundCheck(
      fresh?.soundCheck ?? session.soundCheck,
      check,
    );
    await this.sessions.updateSession(sessionId, { soundCheck: state });
    return state;
  }

  /** POST /sessions/:id/audit/apply — fix → prompt editor draft (§11.2). */
  async applyFix(
    sessionId: string,
    dto: ApplyFixRequestDto,
  ): Promise<ApplyFixResult> {
    const session = await this.load(sessionId);
    const audit = session.videoAudit?.history.find(
      (a) => a.auditId === dto.auditId,
    );
    if (!audit) {
      throw new NotFoundException(
        `Audit ${dto.auditId} not found in this session`,
      );
    }
    const text = dto.text?.trim() || audit.promptFix?.suggestedText;
    if (!text) {
      throw new BadRequestException('This audit has no prompt fix to apply');
    }
    if (!session.generationPrompt) {
      throw new BadRequestException('Session has no prompt');
    }

    // Same semantics as PromptService.updatePrompt: the new text becomes the
    // editable draft and approval is reset — the user re-approves, then
    // regenerates through the existing flow.
    const prompt: GenerationPrompt = {
      ...session.generationPrompt,
      userEditedText: text,
      finalText: text,
      characterCount: text.length,
      approvedAt: undefined,
    };
    const state: VideoAuditState = {
      history: session.videoAudit?.history ?? [],
      appliedFixes: (session.videoAudit?.appliedFixes ?? 0) + 1,
    };
    await this.sessions.updateSession(sessionId, {
      generationPrompt: prompt,
      videoAudit: state,
    });
    return { prompt, state: this.view(state) };
  }

  // ── Gemini ────────────────────────────────────────────────────────────

  private async askVideo(
    pathname: string,
    prompt: string,
    sessionId: string,
  ): Promise<string> {
    const buffer = await this.blob.downloadBuffer(pathname);
    const file = await this.geminiFiles.uploadAndWaitActive(
      buffer,
      'video/mp4',
    );
    try {
      const videoPart: Part = {
        fileData: { fileUri: file.uri, mimeType: file.mimeType },
      };
      const res = await this.genai.models.generateContent({
        model: MODEL,
        contents: [videoPart, { text: prompt }],
        config: { responseMimeType: 'application/json' },
      });
      await this.aiUsage.recordGemini(res, {
        operation: 'audit',
        model: MODEL,
        sessionId,
      });
      return res.text ?? '';
    } finally {
      void this.geminiFiles.deleteFile(file.name);
    }
  }

  private async askText(prompt: string, sessionId: string): Promise<string> {
    const res = await this.genai.models.generateContent({
      model: MODEL,
      contents: [{ text: prompt }],
      config: { responseMimeType: 'application/json' },
    });
    await this.aiUsage.recordGemini(res, {
      operation: 'audit',
      model: MODEL,
      sessionId,
    });
    return res.text ?? '';
  }

  // ── State helpers ─────────────────────────────────────────────────────

  private append(
    current: VideoAuditState | undefined,
    audit: VideoAudit,
  ): VideoAuditState {
    return {
      history: [audit, ...(current?.history ?? [])].slice(0, MAX_HISTORY),
      appliedFixes: current?.appliedFixes ?? 0,
    };
  }

  private view(state: VideoAuditState | undefined): AuditStateView {
    const appliedFixes = state?.appliedFixes ?? 0;
    return {
      history: state?.history ?? [],
      appliedFixes,
      limit: this.limit,
      overLimit: appliedFixes >= this.limit,
    };
  }

  private async load(sessionId: string): Promise<Session> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    return session;
  }
}
