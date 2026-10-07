/**
 * Ответ «целиком, без стрима посетителю» по тем же правилам, что
 * SiteChatService, — W3. Нужен проверке персоны перед публикацией
 * (PersonaGate, §4-тер.8) и eval: тот же поиск под assist_public, тот же
 * промпт (prompt.ts), тот же runChatStream с разделителем действий, те же
 * проверки (источники, действия, пост-фильтр), то же правило «вопрос с
 * признаками инъекции — отказ без модели». Без записи в журнал, кэша,
 * квоты и денег сайта: платит вызывающий (бюджет обучения у PersonaGate).
 */
import { Injectable } from '@nestjs/common';
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import { AssistPublicDb } from '../../prisma/assist-public-db.service';
import { runChatStream } from '../../shared/assist-chat-core';
import { detectInjection } from '../assist-knowledge-core/injection';
import type { SearchHit } from '../assist-knowledge-core/types';
import type { PersonaConfig } from '../assist-site-setup/persona';
import { AiUsageRecorder } from '../site-ai/usage-recorder';
import {
  postFilterAnswer,
  resolveCitations,
  validateSiteActions,
  type SiteAnswerFlag,
} from './answer-checks';
import { SiteChatModel } from './chat-model';
import type {
  SiteAction,
  SiteAnswerSource,
  WidgetSiteContext,
  WidgetStreamErrorCode,
} from './chat-types';
import { buildSitePrompt } from './prompt';
import { PublicSiteSearch } from './public-search';
import { StreamTextGuard } from './stream-guard';
import { TEMPLATE_TEXT, answerLangOf } from './templates';
import {
  insertOnlyUsageDb,
  recordSiteChatUsage,
  type SiteChatOperation,
} from './usage';
import { geminiUsageUnits } from '../../shared/ai-pricing';

export interface OneShotAnswer {
  text: string;
  sources: SiteAnswerSource[];
  actions: SiteAction[];
  flags: SiteAnswerFlag[];
  /** Нет ни одного проверенного источника — фактически «не знаю». */
  refused: boolean;
  path: 'model' | 'refusal';
  costMicroUsd: number;
}

@Injectable()
export class SiteAnswerer {
  constructor(
    private readonly db: AssistPublicDb,
    private readonly search: PublicSiteSearch,
    private readonly model: SiteChatModel,
    private readonly usage: AiUsageRecorder,
  ) {}

  async answer(p: {
    site: WidgetSiteContext;
    siteName: string;
    persona: PersonaConfig | null;
    siteSummary: unknown;
    question: string;
    hosts: string[];
    operation: SiteChatOperation;
  }): Promise<OneShotAnswer> {
    const lang = answerLangOf(p.question, null);
    const refusal = (
      kind: 'injection' | 'no_knowledge',
      cost: number,
    ): OneShotAnswer => ({
      text: TEMPLATE_TEXT[kind][lang],
      sources: [],
      actions: [],
      flags: kind === 'injection' ? ['injection_suspect'] : [],
      refused: true,
      path: 'refusal',
      costMicroUsd: cost,
    });
    if (detectInjection(p.question).quarantine) return refusal('injection', 0);
    const found = await this.search.search(p.site, p.question);
    if (!found.hits.length) return refusal('no_knowledge', found.costMicroUsd);
    const prompt = buildSitePrompt({
      siteName: p.siteName,
      persona: p.persona,
      siteSummary: p.siteSummary,
      hits: found.hits,
      page: { url: null, title: null },
      context: null,
      history: [],
      question: p.question,
      answerLang: lang,
      knowledgeLang: found.knowledgeLang,
      allowedLinkHosts: p.hosts,
    });
    const siteHosts = new Set(p.hosts);
    const linkUrls = new Set<string>([
      ...found.hits.map((h) => h.url).filter((u): u is string => !!u),
      ...p.hosts.map((h) => `https://${h}/`),
    ]);
    const guard = new StreamTextGuard({
      siteHosts,
      sourceNumbers: new Set(prompt.sourceMap.keys()),
    });
    let actions: SiteAction[] = [];
    const stream = runChatStream<SiteAction, WidgetStreamErrorCode>({
      openStream: (signal) =>
        this.model.openStream(
          {
            system: prompt.system,
            contents: prompt.contents,
            maxOutputTokens: WIDGET_DEFAULTS.maxOutputTokens,
          },
          signal,
        ),
      timeouts: {
        firstTokenMs: 30_000,
        totalMs: WIDGET_DEFAULTS.answerTimeoutMs,
      },
      resolveActions: async (raw) =>
        validateSiteActions(raw, { linkUrls, siteHosts }),
      upstreamError: () => ({ code: 'upstream', message: 'upstream' }),
    });
    let r = await stream.next();
    while (!r.done) {
      if (r.value.type === 'token') guard.push(r.value.t);
      else if (r.value.type === 'actions') actions = r.value.items;
      r = await stream.next();
    }
    guard.flush();
    const meta = r.value.usageMeta;
    const cost = await recordSiteChatUsage(
      this.usage,
      insertOnlyUsageDb(this.db),
      {
        accountId: p.site.accountId,
        siteId: p.site.siteId,
        operation: p.operation,
        model: meta ? this.model.model : '',
        units: geminiUsageUnits(meta),
      },
    );
    const total = cost + found.costMicroUsd;
    if (!r.value.ok) {
      return {
        ...refusal('no_knowledge', total),
        text: TEMPLATE_TEXT.partial[lang],
      };
    }
    const { text, sources } = resolveCitations(guard.text, prompt.sourceMap);
    const cited = sources
      .map((s) => prompt.sourceMap.get(s.n))
      .filter((h): h is SearchHit => !!h);
    const flags = postFilterAnswer({
      text,
      question: p.question,
      cited,
      stopPhrases: p.persona?.stopPhrases ?? [],
      siteHosts,
    });
    return {
      text,
      sources,
      actions,
      flags,
      refused: sources.length === 0,
      path: 'model',
      costMicroUsd: total,
    };
  }
}
