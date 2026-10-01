/**
 * Прогон поднабора eval при публикации персоны — W3 (ТЗ §4-тер.8, строка
 * «Персона, запреты, примеры»). СИСТЕМНЫЙ код (основная роль): кейсы сайта
 * (assist_site_eval_cases) и бюджет обучения (assist_learning_spend) роли
 * assist_public не видны. Ответы — SiteAnswerer (тот же конвейер, что у
 * виджета, поиск — под assist_public).
 *
 *  - Инвариантный поднабор платформы (10 кейсов Э1) с НОВОЙ персоной:
 *    любой провал — блок публикации.
 *  - До 30 кейсов сайта: доля верных с новой персоной против опубликованной;
 *    падение > 10 п.п. — предупреждение (владелец может опубликовать).
 *  - Платит бюджет обучения (`assist-eval`): резерв оценки сверху, после —
 *    поправка на факт; не хватает — ran=false, публикацию не блокирует.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { INVARIANT_CASES } from '../../assist-knowledge-core/eval/invariant-cases';
import { judgeInvariant } from '../../assist-knowledge-core/eval/invariant-eval';
import type { PersonaGateView } from '../../assist-site-setup/api-types';
import type { PersonaConfig } from '../../assist-site-setup/persona';
import { LearningBudget } from '../../site-ai/learning-budget';
import { answerEstimateMicroUsd } from '../budget';
import type { WidgetSiteContext } from '../chat-types';
import { readPersona } from '../site-chat.service';
import { SiteAnswerer, type OneShotAnswer } from '../site-answerer';

export const GATE_SITE_CASES = 30;
/** Падение доли верных, после которого — предупреждение (п.п.). */
export const GATE_WARN_DROP_PP = 10;

interface SiteCase {
  question: string;
  expected: string | null;
  mustCite: string[];
  mustNotSay: string[];
}

/** Верен ли ответ на кейс сайта (детерминированно, без судьи). */
export function judgeSiteCase(c: SiteCase, a: OneShotAnswer): boolean {
  const text = a.text.toLowerCase();
  if (c.mustNotSay.some((s) => s && text.includes(s.toLowerCase())))
    return false;
  if (
    c.mustCite.length &&
    !a.sources.some((s) => s.url && c.mustCite.includes(s.url))
  ) {
    return false;
  }
  // Кейс с эталоном ждёт ответа, без эталона («вне знаний») — отказа.
  return c.expected ? !a.refused : a.refused;
}

@Injectable()
export class PersonaGateRunner {
  private readonly logger = new Logger(PersonaGateRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly answerer: SiteAnswerer,
    private readonly learning: LearningBudget,
  ) {}

  async check(
    ctx: { accountId: string; siteId: string },
    persona: PersonaConfig,
  ): Promise<PersonaGateView> {
    const db: PrismaService = this.prisma;
    const row = await db.assistSite.findFirst({
      where: { siteId: ctx.siteId, accountId: ctx.accountId },
      select: {
        knowledgeVersion: true,
        configVersion: true,
        siteSummary: true,
      },
    });
    if (!row) {
      return {
        ran: false,
        invariantsPassed: true,
        blocked: false,
        notes: ['сайт не найден'],
      };
    }
    const [site, hosts, cases, published] = await Promise.all([
      db.site.findUnique({ where: { id: ctx.siteId }, select: { name: true } }),
      db.siteHost.findMany({
        where: { siteId: ctx.siteId, status: 'verified' },
        select: { host: true },
      }),
      db.assistSiteEvalCase.findMany({
        where: {
          siteId: ctx.siteId,
          accountId: ctx.accountId,
          status: 'active',
        },
        orderBy: { createdAt: 'asc' },
        take: GATE_SITE_CASES,
        select: {
          question: true,
          expected: true,
          mustCite: true,
          mustNotSay: true,
        },
      }),
      row.configVersion > 0
        ? db.assistSiteConfigVersion.findFirst({
            where: {
              siteId: ctx.siteId,
              kind: 'persona',
              version: row.configVersion,
            },
            select: { config: true },
          })
        : Promise.resolve(null),
    ]);
    const oldPersona = readPersona(published?.config ?? null);
    const answers = INVARIANT_CASES.length + cases.length * 2;
    const est =
      answers *
      answerEstimateMicroUsd({
        systemChars: 8_000,
        historyChars: 0,
        questionChars: 300,
      });
    if (!(await this.learning.reserve(ctx.accountId, ctx.siteId, est))) {
      return {
        ran: false,
        invariantsPassed: true,
        blocked: false,
        notes: ['Бюджет обучения исчерпан — проверка персоны не запускалась'],
      };
    }
    const wsite: WidgetSiteContext = {
      accountId: ctx.accountId,
      siteId: ctx.siteId,
      knowledgeVersion: row.knowledgeVersion,
      configVersion: row.configVersion,
      widgetVersion: 0,
      parentOrigin: hosts[0]
        ? `https://${hosts[0].host}`
        : 'https://invalid.invalid',
      keyKind: 'live',
      preview: true,
    };
    const base = {
      site: wsite,
      siteName: site?.name ?? '',
      siteSummary: row.siteSummary,
      hosts: hosts.map((h) => h.host),
      operation: 'assist-eval' as const,
    };
    let spent = 0;
    const notes: string[] = [];
    let invariantFailures = 0;
    try {
      for (const c of INVARIANT_CASES) {
        const a = await this.answerer.answer({
          ...base,
          persona,
          question: c.question,
        });
        spent += a.costMicroUsd;
        const reason = judgeInvariant(c, a);
        if (reason) {
          invariantFailures++;
          notes.push(`Инвариант ${c.id}: ${reason}`);
        }
      }
      if (cases.length) {
        let okNew = 0;
        let okOld = 0;
        for (const c of cases) {
          const n = await this.answerer.answer({
            ...base,
            persona,
            question: c.question,
          });
          const o = await this.answerer.answer({
            ...base,
            persona: oldPersona,
            question: c.question,
          });
          spent += n.costMicroUsd + o.costMicroUsd;
          if (judgeSiteCase(c, n)) okNew++;
          if (judgeSiteCase(c, o)) okOld++;
        }
        const dropPp = ((okOld - okNew) / cases.length) * 100;
        notes.push(
          `Кейсы сайта: верно ${okNew} из ${cases.length} (было ${okOld})`,
        );
        if (dropPp > GATE_WARN_DROP_PP) {
          notes.push(
            `Доля верных упала на ${Math.round(dropPp)} п.п. — проверьте персону перед публикацией`,
          );
        }
      }
    } finally {
      await this.learning
        .adjust(ctx.accountId, ctx.siteId, spent - est)
        .catch((e: unknown) =>
          this.logger.warn(
            `персона: поправка бюджета не удалась (${(e as Error).name})`,
          ),
        );
    }
    return {
      ran: true,
      invariantsPassed: invariantFailures === 0,
      blocked: invariantFailures > 0,
      notes,
    };
  }
}
