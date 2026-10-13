/**
 * AI Publisher — вклады пакетов, которых бывает несколько (P-A1, проектный
 * документ §16.0 «PUB_CRON_JOBS (multi-provider)»). В Nest нет
 * multi-provider, а общий модуль-реестр заставил бы ядро импортировать
 * модули пакетов. Поэтому вклад — обычный провайдер пакета с меткой
 * `@PubContribution(kind)`; ядро находит все такие экземпляры через
 * `DiscoveryService` при старте.
 *
 * Виды:
 *  - `cron-job` — задание `/cron/publisher-tick|daily` (`CronJob`, §15.1);
 *  - `product-init` — шаг создания продукта в той же транзакции: канал
 *    `site` и черновик лимита (P-C), эксперимент `pilot` с `t0Planned`
 *    (P-E) — §11.3 `POST /sites/:siteId/product`;
 *  - `member-reassign` — переназначение открытых объектов удалённого
 *    участника владельцу кабинета (заявки — P-D, действия — P-C,
 *    материалы — P-B1; задание `members-reconcile`, §4.1).
 *
 * Ожидаемые ключи каждого вида перечислены здесь (`EXPECTED_*`): чего нет —
 * видно (создание продукта — 501, крон — `missing` в ответе), а не тихо
 * пропущено.
 */
import { Injectable, OnModuleInit, SetMetadata } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { ProductCtx } from '../contracts/common';
import type { CronJob, ProductRef, PubTx } from './ports';

export const PUB_CONTRIBUTION = 'publisher:contribution';

export type ContributionKind = 'cron-job' | 'product-init' | 'member-reassign';

export function PubContribution(kind: ContributionKind): ClassDecorator {
  return SetMetadata(PUB_CONTRIBUTION, kind);
}

export interface ProductInitContext {
  actor: string;
  now: Date;
  /** Значения-допущения, которыми засеян продукт (pilot_calendar и т. п.). */
  parameters: Record<string, unknown>;
}

/** Шаг создания продукта (класс с `@PubContribution('product-init')`). */
export interface ProductInitContributor {
  key: ProductInitKey;
  init(tx: PubTx, product: ProductCtx, ctx: ProductInitContext): Promise<void>;
}

/** Переназначение при удалении участника (`@PubContribution('member-reassign')`). */
export interface MemberReassignContributor {
  key: MemberReassignKey;
  reassign(
    tx: PubTx,
    product: ProductRef,
    fromMemberId: string,
    toMemberId: string,
    actor: string,
  ): Promise<number>;
}

/** Шаги создания продукта и владельцы (§11.3). */
export const EXPECTED_PRODUCT_INIT = {
  'site-channel': 'P-C',
  'budget-limit': 'P-C',
  'pilot-experiment': 'P-E',
} as const;
export type ProductInitKey = keyof typeof EXPECTED_PRODUCT_INIT;

/** Кто держит ссылки на участников, кроме ядра (§4.1). */
export const EXPECTED_MEMBER_REASSIGN = {
  leads: 'P-D',
  'distribution-actions': 'P-C',
  contents: 'P-B1',
} as const;
export type MemberReassignKey = keyof typeof EXPECTED_MEMBER_REASSIGN;

interface ByKind {
  'cron-job': CronJob;
  'product-init': ProductInitContributor;
  'member-reassign': MemberReassignContributor;
}

@Injectable()
export class PubContributions implements OnModuleInit {
  private found: { [K in ContributionKind]: Array<ByKind[K]> } = {
    'cron-job': [],
    'product-init': [],
    'member-reassign': [],
  };

  private loaded = false;

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    this.refresh();
  }

  /** Пересобрать (тесты подменяют провайдеры после старта). */
  refresh(): void {
    const next: typeof this.found = {
      'cron-job': [],
      'product-init': [],
      'member-reassign': [],
    };
    for (const w of this.discovery.getProviders()) {
      const cls = w.metatype as unknown;
      if (!w.instance || typeof cls !== 'function') continue;
      const kind = Reflect.getMetadata(PUB_CONTRIBUTION, cls) as
        ContributionKind | undefined;
      if (!kind || !(kind in next)) continue;
      const list = next[kind] as unknown[];
      if (!list.includes(w.instance)) list.push(w.instance);
    }
    for (const kind of Object.keys(next) as ContributionKind[]) {
      const keys = (next[kind] as Array<{ key: string }>).map((x) => x.key);
      const dup = keys.find((k, i) => keys.indexOf(k) !== i);
      if (dup) {
        throw new Error(
          `Publisher: вклад «${kind}» с ключом «${dup}» зарегистрирован дважды`,
        );
      }
    }
    this.found = next;
    this.loaded = true;
  }

  list<K extends ContributionKind>(kind: K): Array<ByKind[K]> {
    // Хуки модулей вызываются по очереди: вызов раньше своего onModuleInit
    // (реестр крона) не должен увидеть пустой список.
    if (!this.loaded) this.refresh();
    return [...this.found[kind]] as Array<ByKind[K]>;
  }
}
