/**
 * Атрибуция кабинета (лендинг-ТЗ §7.3, Д-8) — W2. Кабинетный код под
 * основной ролью (SitesDb.forAccount): TMA при первом запуске с payload
 * лендинга (`lp_|pl_|wd_|sb_`, разбор — site-tma-kit/start-param.ts)
 * сообщает его; одна запись на кабинет (первый вход), повтор — recorded=false.
 * utm: только ключи utm_* ≤ 5, значения ≤ 100.
 *
 * «Одна на кабинет» без уникального индекса (схема — у координатора):
 * транзакционная advisory-блокировка по кабинету сериализует два
 * параллельных первых запуска (две вкладки TMA), проверка и вставка — под ней.
 */
import { HttpException, Injectable } from '@nestjs/common';
import { SitesDb } from '../../../prisma/sites-db.service';
import type { AccountMembership } from '../../site-core/account/roles';
import type {
  AcquisitionRequest,
  AcquisitionResult,
} from '../landing/landing-types';

/** start_param Telegram — ≤ 64 символов [A-Za-z0-9_-]. */
const PAYLOAD_RE = /^(lp|pl|wd|sb)_([A-Za-z0-9_-]{1,61})$/;
const UTM_KEY_RE = /^utm_[a-z0-9_]{1,30}$/;
const MAX_UTM = 5;
const MAX_UTM_VALUE = 100;
const MAX_PATH = 200;

export interface ParsedAcquisition {
  payload: string;
  source: 'lp' | 'pl' | 'wd' | 'sb';
  /** Кампания лендинга или тариф — только у lp_/pl_ (у wd_/sb_ — секретный id). */
  campaign: string | null;
  utm: Record<string, string> | null;
  landingPath: string | null;
}

/** null — payload не наш (без исключения: TMA шлёт что получила). */
export function parseAcquisition(body: unknown): ParsedAcquisition | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.payload !== 'string') return null;
  const m = PAYLOAD_RE.exec(b.payload);
  if (!m) return null;
  const source = m[1] as ParsedAcquisition['source'];
  let utm: Record<string, string> | null = null;
  if (b.utm && typeof b.utm === 'object' && !Array.isArray(b.utm)) {
    const entries = Object.entries(b.utm as Record<string, unknown>)
      .filter(
        (e): e is [string, string] =>
          UTM_KEY_RE.test(e[0]) &&
          typeof e[1] === 'string' &&
          e[1].length > 0 &&
          e[1].length <= MAX_UTM_VALUE,
      )
      .slice(0, MAX_UTM);
    if (entries.length) utm = Object.fromEntries(entries);
  }
  let landingPath: string | null = null;
  if (typeof b.landingPath === 'string' && b.landingPath.startsWith('/')) {
    const p = b.landingPath.split(/[?#]/, 1)[0];
    if (p && p.length <= MAX_PATH && !/[\s<>"']/.test(p)) landingPath = p;
  }
  return {
    payload: b.payload,
    source,
    campaign: source === 'lp' || source === 'pl' ? m[2] : null,
    utm,
    landingPath,
  };
}

@Injectable()
export class AcquisitionService {
  constructor(private readonly sites: SitesDb) {}

  async record(
    m: AccountMembership,
    body: AcquisitionRequest,
  ): Promise<AcquisitionResult> {
    const parsed = parseAcquisition(body);
    if (!parsed) {
      throw new HttpException(
        { error: 'BAD_REQUEST', message: 'Неизвестный payload лендинга' },
        400,
      );
    }
    const db = this.sites.forAccount(m.accountId);
    return db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assist-acquisition:${m.accountId}`}))`;
      const existing = await tx.assistAcquisition.findFirst({
        where: { accountId: m.accountId },
        select: { id: true },
      });
      if (existing) return { recorded: false };
      await tx.assistAcquisition.create({
        data: {
          accountId: m.accountId,
          payload: parsed.payload,
          source: parsed.source,
          campaign: parsed.campaign,
          landingPath: parsed.landingPath,
          utm: parsed.utm ?? undefined,
        },
        select: { id: true },
      });
      return { recorded: true };
    });
  }
}
