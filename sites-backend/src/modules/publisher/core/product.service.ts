/**
 * AI Publisher — продукт: создание, профиль, имя, режим (P-A1, проектный
 * документ §3, §11.3).
 *
 * Создание (`POST /publisher/sites/:siteId/product`, `publisher=admin`) —
 * одна транзакция `runOperation` (ключ идемпотентности уровня кабинета):
 * сайт — только этого кабинета, второй продукт на сайт — 409
 * `PUB_PRODUCT_EXISTS`; публичный ключ `pp_` + 24 base62; 37
 * параметров-допущений; кампания «пилот»; затем шаги пакетов
 * (`@PubContribution('product-init')`): канал `site` и черновик лимита
 * (P-C), эксперимент `pilot` с `t0Planned` (P-E). Шаг, которого ещё нет, —
 * 501 `PUB_NOT_IMPLEMENTED {missing}` ДО записи (не «успех» без канала).
 *
 * Режим (машина §3.2): `live` — только `kind=working` с открытым гейтом
 * `public_publish` (параметры + verified-хост `domain_host`); `eval` и
 * `restored` режим не меняют.
 */
import { Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import { PUBLISHER_KEY_PREFIX } from '../../../brand';
import { publisherRedditEnabled } from '../../../config/publisher-env';
import {
  GATE_NAMES,
  type GateName,
  type ProductCtx,
  type ProductView,
} from '../contracts/common';
import { DEFAULT_PARAMETER_VALUES } from '../contracts/parameters';
import {
  PRODUCT_MODES,
  isOneOf,
  type ProductKind,
  type ProductMode,
  type ProductStatus,
} from '../contracts/states';
import { AuditService } from './audit';
import {
  EXPECTED_PRODUCT_INIT,
  PubContributions,
  type ProductInitKey,
} from './contributions';
import { PubError, validationError } from './errors';
import { evaluateGate } from './gates';
import { lockProduct } from './refresh-gate-flags';
import { ParametersService } from './parameters.service';
import type { PubTx } from './ports';
import { toProductCtx } from './product-access.service';
import { refreshGateFlags } from './refresh-gate-flags';
import { casUpdate } from './revision';
import { myRolesOf, type PubAccess } from './roles';
import { PRODUCT_MODE_MACHINE, assertTransition } from './state-machines';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const PILOT_CAMPAIGN_CODE = 'pilot';
export const PILOT_CAMPAIGN_NAME = 'Пілот';
/** Виды, которые создаёт кабинет (`restored` — только восстановление P-E). */
export const CREATABLE_KINDS = ['working', 'test', 'eval'] as const;

export function newPublicKey(): string {
  let s = PUBLISHER_KEY_PREFIX;
  for (let i = 0; i < 24; i++) s += BASE62[randomInt(BASE62.length)];
  return s;
}

export function checkProductName(v: unknown): string {
  if (typeof v !== 'string')
    throw validationError([{ field: 'name', code: 'required' }]);
  const name = v.trim();
  if (name.length < 1 || [...name].length > 120) {
    throw validationError([{ field: 'name', code: 'length' }]);
  }
  return name;
}

@Injectable()
export class ProductService {
  constructor(
    private readonly audit: AuditService,
    private readonly parameters: ParametersService,
    private readonly contributions: PubContributions,
  ) {}

  /** Шаги создания, которых ещё нет (до интеграции пакетов этапа 1). */
  missingInitSteps(): ProductInitKey[] {
    const have = new Set(
      this.contributions.list('product-init').map((c) => c.key),
    );
    return (Object.keys(EXPECTED_PRODUCT_INIT) as ProductInitKey[]).filter(
      (k) => !have.has(k),
    );
  }

  async create(
    tx: PubTx,
    accountId: string,
    siteId: string,
    input: { name: unknown; kind: unknown },
    actor: string,
    now: Date,
  ): Promise<ProductCtx> {
    const name = checkProductName(input.name);
    if (!isOneOf(CREATABLE_KINDS, input.kind)) {
      throw validationError([{ field: 'kind', code: 'enum' }]);
    }
    const kind = input.kind;
    const site = await tx.site.findFirst({
      where: { id: siteId },
      select: { id: true },
    });
    if (!site) throw new PubError('PUB_NOT_FOUND');
    const existing = await tx.pubProduct.findFirst({
      where: { siteId },
      select: { id: true },
    });
    if (existing)
      throw new PubError('PUB_PRODUCT_EXISTS', { productId: existing.id });
    const missing = this.missingInitSteps();
    if (missing.length) {
      throw new PubError('PUB_NOT_IMPLEMENTED', {
        step: 'product-init',
        missing: missing.map((k) => ({
          key: k,
          owner: EXPECTED_PRODUCT_INIT[k],
        })),
      });
    }
    const row = await tx.pubProduct.create({
      data: {
        accountId,
        siteId,
        kind,
        name,
        publicKey: newPublicKey(),
        mode: 'closed',
        status: 'active',
        createdBy: actor,
      },
    });
    const product = toProductCtx(row);
    await this.parameters.seed(tx, product, actor);
    await tx.pubCampaign.create({
      data: {
        accountId,
        productId: product.id,
        code: PILOT_CAMPAIGN_CODE,
        name: PILOT_CAMPAIGN_NAME,
        createdBy: actor,
      },
    });
    for (const step of this.contributions.list('product-init')) {
      await step.init(tx, product, {
        actor,
        now,
        parameters: { ...DEFAULT_PARAMETER_VALUES },
      });
    }
    await refreshGateFlags(tx, product.id);
    await this.audit.write(tx, {
      accountId,
      productId: product.id,
      actor,
      objectType: 'product',
      objectId: product.id,
      action: 'create',
      toStatus: 'closed',
      meta: { kind, siteId },
    });
    return product;
  }

  async view(
    tx: PubTx,
    productId: string,
    access: PubAccess,
    now: Date,
  ): Promise<ProductView> {
    const p = await tx.pubProduct.findFirst({ where: { id: productId } });
    if (!p) throw new PubError('PUB_NOT_FOUND');
    const gates = {} as ProductView['gates'];
    for (const g of GATE_NAMES) {
      const r = await evaluateGate(tx, productId, g as GateName, now);
      gates[g] = { open: r.open, missingCount: r.missing.length };
    }
    return {
      id: p.id,
      siteId: p.siteId,
      kind: p.kind as ProductKind,
      name: p.name,
      publicKey: p.publicKey,
      mode: p.mode as ProductMode,
      liveSince: p.liveSince?.toISOString() ?? null,
      status: p.status as ProductStatus,
      revision: p.revision,
      createdAt: p.createdAt.toISOString(),
      myRoles: myRolesOf(access),
      gates,
      features: { reddit: publisherRedditEnabled() },
    };
  }

  async rename(
    tx: PubTx,
    product: ProductCtx,
    input: { name: unknown; expectedRevision: number },
    actor: string,
  ): Promise<void> {
    const name = checkProductName(input.name);
    await casUpdate(tx.pubProduct, product.id, input.expectedRevision, {
      name,
    });
    await this.audit.write(tx, {
      accountId: product.accountId,
      productId: product.id,
      actor,
      objectType: 'product',
      objectId: product.id,
      action: 'update',
      meta: { field: 'name' },
    });
  }

  async changeMode(
    tx: PubTx,
    product: ProductCtx,
    input: { mode: unknown; expectedRevision: number; reason?: unknown },
    actor: string,
    now: Date,
  ): Promise<void> {
    if (!isOneOf(PRODUCT_MODES, input.mode)) {
      throw validationError([{ field: 'mode', code: 'enum' }]);
    }
    const to = input.mode;
    // Аудит P1-1: блокировка строки продукта до чтения гейта — параллельный
    // отзыв параметра ждёт фиксации смены режима (и наоборот).
    await lockProduct(tx, product);
    // Текущее состояние — из транзакции (а не из гварда): CAS ниже.
    const cur = await tx.pubProduct.findFirst({
      where: { id: product.id },
      select: { mode: true, kind: true, revision: true, status: true },
    });
    if (!cur) throw new PubError('PUB_NOT_FOUND');
    const from = cur.mode as ProductMode;
    if (
      cur.kind === 'eval' ||
      cur.kind === 'restored' ||
      cur.status !== 'active'
    ) {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: PRODUCT_MODE_MACHINE.name,
        from,
        to,
        allowed: [],
        reason: cur.status !== 'active' ? 'archived' : `kind_${cur.kind}`,
      });
    }
    assertTransition(PRODUCT_MODE_MACHINE, from, to, { actors: ['admin'] });
    if (to === 'live') {
      if (cur.kind !== 'working') {
        throw new PubError('PUB_TRANSITION_INVALID', {
          machine: PRODUCT_MODE_MACHINE.name,
          from,
          to,
          allowed: ['closed', 'test'].filter((m) => m !== from),
          reason: 'kind_not_working',
        });
      }
      const gate = await evaluateGate(tx, product.id, 'public_publish', now);
      if (!gate.open) {
        throw new PubError('PUB_GATE_CLOSED', {
          gate: 'public_publish',
          missing: gate.missing,
        });
      }
    }
    if (from === 'live' && to === 'closed') {
      // Аудит P3-6, ТЗ §17/§3.2: форма при закрытии показывает честное
      // сообщение и альтернативный контакт — он должен быть утверждён.
      const alt = await tx.pubParameter.findFirst({
        where: { productId: product.id, key: 'alt_contact' },
        select: { status: true, value: true },
      });
      const href = (alt?.value as { href?: unknown } | null)?.href;
      if (alt?.status !== 'approved' || typeof href !== 'string' || !href) {
        throw new PubError('PUB_PARAMETER_UNAPPROVED', {
          key: 'alt_contact',
          status: alt?.status ?? 'missing',
        });
      }
    }
    let reason: string | null = null;
    if (input.reason !== undefined && input.reason !== null) {
      if (typeof input.reason !== 'string' || [...input.reason].length > 2000) {
        throw validationError([{ field: 'reason', code: 'length' }]);
      }
      reason = input.reason;
    }
    await casUpdate(tx.pubProduct, product.id, input.expectedRevision, {
      mode: to,
      ...(to === 'live' ? { liveSince: now } : {}),
    });
    await this.audit.write(tx, {
      accountId: product.accountId,
      productId: product.id,
      actor,
      objectType: 'product',
      objectId: product.id,
      action: 'transition',
      fromStatus: from,
      toStatus: to,
      reason,
      meta: { field: 'mode' },
    });
  }
}
