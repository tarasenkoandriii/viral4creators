/**
 * Приём лида из формы виджета — W3 (ТЗ §3.6 п.6, §6.2, К-3; приёмка Э2 п.7).
 * Только явной отправкой формы посетителем: модель «записать лид» не может.
 *
 * Под ролью assist_public: проверка полей по assist_sites.leadsConfig
 * (форма — W4 leads-config.ts; действует сразу, без публикации; нет
 * настройки — defaultLeadsConfig), согласие обязательно, текст согласия —
 * из настройки на языке uiLang (не из запроса), поля шифруются
 * (AES-256-GCM ключом из ASSIST_SECRETS_KEY, как token-crypto), запись —
 * createMany (без RETURNING: у роли нет SELECT на лиды). Сразу после записи —
 * LeadDelivery.deliver(id) (system/, основная роль) в фоне (waitUntil);
 * сбой доставки — повтор кроном assist-budget-sweep.
 *
 * Уточнение W3: `@vercel/functions` (waitUntil) в проекте нет (контракт §1
 * п.10), а функция Node живёт, пока обработчик не ответил, — поэтому
 * доставка ЖДЁТСЯ, но не дольше LEAD_DELIVERY_WAIT_MS и без ошибки наружу:
 * лид уже записан, остальное довезёт крон. В лог — только id и код (§6.6).
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import { AssistPublicDb } from '../../prisma/assist-public-db.service';
import {
  defaultLeadsConfig,
  parseLeadsConfig,
  type LeadField,
  type LeadsConfig,
} from '../assist-site-setup/leads-config';
import type { WidgetSiteContext, WidgetVisitor } from './chat-types';
import { chatError } from './chat-errors';
import { encryptLeadFields, leadKey, type LeadFields } from './lead-crypto';
import { LeadDelivery } from './system/lead-delivery.service';

export interface LeadSubmitInput {
  site: WidgetSiteContext;
  visitor: WidgetVisitor;
  conversationId: string | null;
  fields: Partial<Record<'name' | 'phone' | 'email' | 'comment', string>>;
  /** Посетитель отметил согласие; текст берётся из опубликованной настройки, не из запроса. */
  consent: boolean;
  uiLang: 'uk' | 'ru' | 'en';
  pageUrl: string | null;
}

export const LEAD_DELIVERY_WAIT_MS = 5_000;

const PHONE = /^\+?[0-9 ()-]{7,24}$/;
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,24}$/i;

/** Форма лида сайта: настройка (строгий разбор W4) или умолчание. */
export function effectiveLeadsConfig(raw: unknown): LeadsConfig {
  if (raw !== null && raw !== undefined) {
    const r = parseLeadsConfig(raw);
    if (r.ok) return r.config;
  }
  return defaultLeadsConfig();
}

/** Текст согласия в той редакции, что видел посетитель (язык интерфейса). */
export function consentTextFor(
  cfg: LeadsConfig,
  lang: 'uk' | 'ru' | 'en',
): string | null {
  const t =
    cfg.consentText[lang] ??
    cfg.consentText.uk ??
    cfg.consentText.ru ??
    cfg.consentText.en;
  return t?.trim() ? t.trim() : null;
}

function clean(v: string): string {
  return (
    v
      .normalize('NFKC')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮]/g, '')
      .trim()
  );
}

/** Проверка полей по форме; ошибки — имена полей и коды (без значений). */
export function validateLeadFields(
  cfg: LeadsConfig,
  input: LeadSubmitInput['fields'],
):
  | { ok: true; fields: LeadFields }
  | { ok: false; errors: Array<{ field: string; code: string }> } {
  const errors: Array<{ field: string; code: string }> = [];
  const allowed = new Map(cfg.fields.map((f) => [f.field, f.required]));
  const out: LeadFields = {};
  for (const [k, raw] of Object.entries(input ?? {})) {
    if (typeof raw !== 'string') {
      errors.push({ field: k, code: 'type' });
      continue;
    }
    const v = clean(raw);
    if (!v) continue;
    if (!allowed.has(k as LeadField)) {
      errors.push({ field: k, code: 'unknown' });
      continue;
    }
    const max =
      k === 'comment'
        ? WIDGET_DEFAULTS.leadCommentMaxChars
        : WIDGET_DEFAULTS.leadFieldMaxChars;
    if (v.length > max) errors.push({ field: k, code: 'too_long' });
    else if (
      k === 'phone' &&
      (!PHONE.test(v) || (v.match(/\d/g) ?? []).length < 7)
    ) {
      errors.push({ field: k, code: 'format' });
    } else if (k === 'email' && !EMAIL.test(v)) {
      errors.push({ field: k, code: 'format' });
    } else out[k as LeadField] = v;
  }
  for (const [field, required] of allowed) {
    if (required && !out[field] && !errors.some((e) => e.field === field)) {
      errors.push({ field, code: 'required' });
    }
  }
  if (!out.phone && !out.email && !errors.length) {
    errors.push({ field: 'phone|email', code: 'contact_required' });
  }
  return errors.length ? { ok: false, errors } : { ok: true, fields: out };
}

/** Страница лида — без query и фрагмента (§6.6), только http(s). */
export function leadPageUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.origin}${u.pathname}`.slice(0, 500);
  } catch {
    return null;
  }
}

@Injectable()
export class SiteLeadsService {
  private readonly logger = new Logger(SiteLeadsService.name);
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  constructor(
    private readonly db: AssistPublicDb,
    private readonly delivery: LeadDelivery,
  ) {}

  async submit(input: LeadSubmitInput): Promise<{ leadId: string }> {
    const site = input.site;
    if (input.consent !== true) {
      throw chatError('CONSENT_REQUIRED', 'Нужно согласие на обработку данных');
    }
    const row = await this.db.assistSite.findUnique({
      where: { siteId: site.siteId },
      select: { leadsConfig: true },
    });
    if (!row) throw chatError('WIDGET_DISABLED', 'Виджет недоступен');
    const cfg = effectiveLeadsConfig(row.leadsConfig);
    const consentText = consentTextFor(cfg, input.uiLang);
    if (!consentText) {
      throw chatError('LEAD_INVALID', 'Форма заявки не настроена');
    }
    const v = validateLeadFields(cfg, input.fields);
    if (!v.ok) {
      throw chatError('LEAD_INVALID', 'Проверьте поля заявки', {
        errors: v.errors,
      });
    }
    const key = leadKey(this.env);
    if (!key) {
      this.logger.error('лид не принят: нет ASSIST_SECRETS_KEY');
      throw chatError('WIDGET_DISABLED', 'Заявки временно не принимаются');
    }
    // Чужой диалог (другой посетитель/сайт) — лид без ссылки, не ошибка.
    const conv = input.conversationId
      ? await this.db.assistSiteConversation.findFirst({
          where: {
            id: input.conversationId,
            siteId: site.siteId,
            visitorId: input.visitor.visitorId,
          },
          select: { id: true },
        })
      : null;
    const id = randomUUID();
    const now = this.now();
    await this.db.assistSiteLead.createMany({
      data: [
        {
          id,
          accountId: site.accountId,
          siteId: site.siteId,
          conversationId: conv?.id ?? null,
          visitorId: input.visitor.visitorId,
          fieldsEnc: encryptLeadFields(v.fields, id, key),
          fieldNames: Object.keys(v.fields),
          consentText,
          consentAt: now,
          pageUrl: leadPageUrl(input.pageUrl),
          createdAt: now,
        },
      ],
    });
    if (conv) {
      await this.db.assistSiteConversation.update({
        where: { id: conv.id },
        data: { outcome: 'lead', stateVersion: { increment: 1 } },
        select: { id: true },
      });
    }
    this.logger.log(`лид ${id} принят (site ${site.siteId})`);
    await this.deliverSoon(id);
    return { leadId: id };
  }

  private async deliverSoon(id: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        this.delivery.deliver(id),
        new Promise<void>(
          (r) => (timer = setTimeout(r, LEAD_DELIVERY_WAIT_MS)),
        ),
      ]);
    } catch (e) {
      this.logger.warn(
        `лид ${id}: доставка отложена (${(e as Error | null)?.name ?? 'Error'})`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
