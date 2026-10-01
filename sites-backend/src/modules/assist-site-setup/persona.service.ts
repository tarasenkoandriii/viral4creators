/**
 * Кабинет: персона и настройки лидов (ТЗ §3.5, §3.6 п.6). Владелец — W4.
 *
 * Публикация персоны: перед ней — PersonaGate.check (W3, assist-site-chat):
 * провал инвариантов блокирует (§4-тер.8), падение доли верных — только
 * предупреждение. Публикация = строка assist_site_config_versions(kind=persona)
 * + assist_sites.configVersion+1 (условным UPDATE) — смена ключа
 * семантического кэша (§4-тер.2).
 *
 * Откат к версии N — без повторного прогона ворот: N уже проходила их при
 * публикации, а откат — аварийная кнопка «верните как было» и не должен
 * зависеть от бюджета обучения.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import { SitesDb } from '../../prisma/sites-db.service';
import { PersonaGate } from '../assist-site-chat/persona-gate';
import type { AccountMembership } from '../site-core/account/roles';
import type {
  LeadsConfigView,
  PersonaGateView,
  PersonaSettingsView,
} from './api-types';
import { setupError } from './errors';
import { defaultLeadsConfig, parseLeadsConfig } from './leads-config';
import {
  PERSONA_FALLBACK_LANG,
  defaultPersona,
  parsePersona,
  type PersonaConfig,
} from './persona';
import {
  historyItem,
  loadAssistSite,
  publishConfigVersion,
} from './widget-settings.service';

type Db = ReturnType<SitesDb['forAccount']>;
type Row = Awaited<ReturnType<typeof loadAssistSite>>['row'];

function gateView(v: unknown): PersonaGateView | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return {
    ran: o.ran === true,
    invariantsPassed: o.invariantsPassed === true,
    blocked: o.blocked === true,
    notes: Array.isArray(o.notes)
      ? o.notes.filter((n): n is string => typeof n === 'string')
      : [],
  };
}

@Injectable()
export class PersonaService {
  constructor(
    private readonly sitesDb: SitesDb,
    private readonly gate: PersonaGate,
  ) {}

  private db(m: AccountMembership): Db {
    return this.sitesDb.forAccount(m.accountId);
  }

  /** Черновик: сохранённый (W5 дописывает запреты/правила) или умолчание. */
  private draftOf(row: Row): PersonaConfig {
    const p = row.personaDraft ? parsePersona(row.personaDraft) : null;
    return p?.ok ? p.persona : defaultPersona(PERSONA_FALLBACK_LANG);
  }

  private async view(
    db: Db,
    siteId: string,
    row: Row,
  ): Promise<PersonaSettingsView> {
    const versions = await db.assistSiteConfigVersion.findMany({
      where: { siteId, kind: 'persona' },
      orderBy: { version: 'desc' },
      take: WIDGET_DEFAULTS.configHistoryKeep,
      select: {
        version: true,
        config: true,
        gateReport: true,
        createdAt: true,
        publishedByTelegramId: true,
        rolledBackFrom: true,
      },
    });
    const published =
      row.configVersion > 0
        ? versions.find((v) => v.version === row.configVersion)
        : undefined;
    return {
      siteId,
      configVersion: row.configVersion,
      published: published
        ? (published.config as unknown as PersonaConfig)
        : null,
      draft: this.draftOf(row),
      history: versions.map(historyItem),
      lastGate: gateView(versions.find((v) => v.gateReport)?.gateReport),
    };
  }

  async get(
    m: AccountMembership,
    siteId: string,
  ): Promise<PersonaSettingsView> {
    const db = this.db(m);
    const { row } = await loadAssistSite(db, m.accountId, siteId);
    return this.view(db, siteId, row);
  }

  async saveDraft(
    m: AccountMembership,
    siteId: string,
    persona: unknown,
  ): Promise<PersonaSettingsView> {
    const db = this.db(m);
    const { row } = await loadAssistSite(db, m.accountId, siteId);
    const parsed = parsePersona(persona);
    if (!parsed.ok) {
      throw setupError(400, 'PERSONA_INVALID', 'Персона не прошла проверку', {
        errors: parsed.errors,
      });
    }
    const saved = await db.assistSite.update({
      where: { id: row.id },
      data: {
        personaDraft: parsed.persona as unknown as Prisma.InputJsonValue,
      },
    });
    return this.view(db, siteId, saved);
  }

  async publish(
    m: AccountMembership,
    siteId: string,
  ): Promise<PersonaSettingsView> {
    const db = this.db(m);
    const { row } = await loadAssistSite(db, m.accountId, siteId);
    const persona = this.draftOf(row);
    const report = await this.gate.check(
      { accountId: m.accountId, siteId },
      persona,
    );
    if (report.blocked) {
      throw setupError(
        409,
        'PERSONA_GATE_FAILED',
        'Персона нарушает обязательные правила помощника — публикация отменена',
        { reason: report.notes.join('; ').slice(0, 500) },
      );
    }
    await publishConfigVersion(db, {
      accountId: m.accountId,
      siteId,
      kind: 'persona',
      config: persona,
      gateReport: report,
      byTelegramId: m.telegramId,
    });
    const fresh = await db.assistSite.findFirstOrThrow({ where: { siteId } });
    return this.view(db, siteId, fresh);
  }

  async rollback(
    m: AccountMembership,
    siteId: string,
    version: number,
  ): Promise<PersonaSettingsView> {
    const db = this.db(m);
    await loadAssistSite(db, m.accountId, siteId);
    const old = await db.assistSiteConfigVersion.findFirst({
      where: { siteId, kind: 'persona', version },
      select: { config: true },
    });
    if (!old) {
      throw setupError(404, 'VERSION_NOT_FOUND', 'Такой версии нет в истории');
    }
    await publishConfigVersion(db, {
      accountId: m.accountId,
      siteId,
      kind: 'persona',
      config: old.config,
      rolledBackFrom: version,
      byTelegramId: m.telegramId,
    });
    const fresh = await db.assistSite.findFirstOrThrow({ where: { siteId } });
    return this.view(db, siteId, fresh);
  }

  async getLeads(
    m: AccountMembership,
    siteId: string,
  ): Promise<LeadsConfigView> {
    const db = this.db(m);
    const { row } = await loadAssistSite(db, m.accountId, siteId);
    const p = row.leadsConfig ? parseLeadsConfig(row.leadsConfig) : null;
    return { siteId, config: p?.ok ? p.config : defaultLeadsConfig() };
  }

  /** Действует сразу, без публикации (контракт Э2 §5 «W3 ↔ W4»). */
  async saveLeads(
    m: AccountMembership,
    siteId: string,
    config: unknown,
  ): Promise<LeadsConfigView> {
    const db = this.db(m);
    const { row } = await loadAssistSite(db, m.accountId, siteId);
    const p = parseLeadsConfig(config);
    if (!p.ok) {
      throw setupError(
        400,
        'LEADS_CONFIG_INVALID',
        'Настройки формы заявки не прошли проверку',
        { errors: p.errors },
      );
    }
    await db.assistSite.update({
      where: { id: row.id },
      data: { leadsConfig: p.config as unknown as Prisma.InputJsonValue },
    });
    return { siteId, config: p.config };
  }
}
