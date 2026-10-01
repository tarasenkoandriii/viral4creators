/**
 * Бюджет обучения — K2 (ТЗ §4-тер.11, Р-58): месячный потолок подписки
 * кабинета (до Э4 — learningBudgetCapMicroUsd из config/assist-defaults),
 * делится между сайтами кабинета с помощником поровну или по
 * AssistSite.learningShareBp. Таблица assist_learning_spend: резерв —
 * одним условным UPDATE … WHERE spent <= доля − оценка (строку периода
 * создаёт INSERT … ON CONFLICT DO NOTHING перед ним, §4.5 п.1); после
 * вызова — поправка на факт (adjust).
 *
 * Почему условный UPDATE, а не «прочитать и сравнить»: два тика крона и
 * кнопка владельца могут резервировать одновременно — проверка и списание
 * обязаны быть одним оператором, иначе оба пройдут по старому остатку.
 *
 * Исчерпан → плановые прогоны и черновики откладываются; ворота (код),
 * исключения и удаление — никогда; эмбеддинги обхода — только «горячие
 * страницы» (§4-тер.11). Это решают вызывающие; здесь только счётчик.
 */
import { Injectable } from '@nestjs/common';
import { learningBudgetCapMicroUsd } from '../../config/assist-defaults';
import { SitesDb } from '../../prisma/sites-db.service';

export interface LearningBudgetStatus {
  period: string;
  /** Доля ЭТОГО сайта в потолке кабинета на период. */
  capMicroUsd: number;
  spentMicroUsd: number;
}

/** Период бюджета — календарный месяц UTC. */
export function budgetPeriod(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/**
 * Доля сайта: явная `learningShareBp` (базисные пункты от потолка) или
 * поровну из того, что осталось после явных долей, между сайтами без неё.
 * Сайт, у которого помощник ещё не включён, считается среди «поровну» —
 * иначе первый документ до включения получил бы весь потолок кабинета.
 */
export function siteShareMicroUsd(
  capMicroUsd: number,
  siteId: string,
  sites: Array<{ siteId: string; learningShareBp: number | null }>,
): number {
  const list = sites.some((s) => s.siteId === siteId)
    ? sites
    : [...sites, { siteId, learningShareBp: null }];
  const self = list.find((s) => s.siteId === siteId)!;
  const bp = (v: number) => Math.min(Math.max(v, 0), 10_000);
  if (self.learningShareBp !== null) {
    return Math.floor((capMicroUsd * bp(self.learningShareBp)) / 10_000);
  }
  const explicit = list
    .filter((s) => s.learningShareBp !== null)
    .reduce((sum, s) => sum + bp(s.learningShareBp as number), 0);
  const restBp = Math.max(0, 10_000 - explicit);
  const equal = list.filter((s) => s.learningShareBp === null).length;
  return Math.floor((capMicroUsd * restBp) / 10_000 / Math.max(1, equal));
}

@Injectable()
export class LearningBudget {
  /** Часы — для тестов смены периода; в проде системное время. */
  now: () => Date = () => new Date();

  constructor(private readonly sitesDb: SitesDb) {}

  private async share(accountId: string, siteId: string): Promise<number> {
    const db = this.sitesDb.forAccount(accountId);
    const sites = await db.assistSite.findMany({
      where: { OR: [{ enabled: true }, { siteId }] },
      select: { siteId: true, learningShareBp: true },
    });
    return siteShareMicroUsd(
      learningBudgetCapMicroUsd(accountId),
      siteId,
      sites,
    );
  }

  private async ensureRow(
    accountId: string,
    siteId: string,
    period: string,
  ): Promise<void> {
    await this.sitesDb.forAccount(accountId).assistLearningSpend.createMany({
      data: [{ accountId, siteId, period, spentMicroUsd: BigInt(0) }],
      skipDuplicates: true,
    });
  }

  /**
   * Зарезервировать оценку. false — не помещается в долю сайта (ничего не
   * списано). Нулевая/отрицательная оценка — всегда true.
   */
  async reserve(
    accountId: string,
    siteId: string,
    estMicroUsd: number,
  ): Promise<boolean> {
    const est = Math.ceil(estMicroUsd);
    if (!(est > 0)) return true;
    const period = budgetPeriod(this.now());
    const share = await this.share(accountId, siteId);
    if (est > share) return false;
    await this.ensureRow(accountId, siteId, period);
    const res = await this.sitesDb
      .forAccount(accountId)
      .assistLearningSpend.updateMany({
        where: {
          siteId,
          period,
          spentMicroUsd: { lte: BigInt(share - est) },
        },
        data: { spentMicroUsd: { increment: BigInt(est) } },
      });
    return res.count === 1;
  }

  /** Поправка резерва на факт (может быть отрицательной). */
  async adjust(
    accountId: string,
    siteId: string,
    deltaMicroUsd: number,
  ): Promise<void> {
    const delta = Math.round(deltaMicroUsd);
    if (delta === 0 || !Number.isFinite(delta)) return;
    const period = budgetPeriod(this.now());
    await this.ensureRow(accountId, siteId, period);
    const db = this.sitesDb.forAccount(accountId);
    if (delta > 0) {
      // Факт дороже оценки: деньги уже потрачены — списываем без условия.
      await db.assistLearningSpend.updateMany({
        where: { siteId, period },
        data: { spentMicroUsd: { increment: BigInt(delta) } },
      });
      return;
    }
    // Возврат не уводит счётчик ниже нуля (резерв мог быть в прошлом месяце).
    const back = BigInt(-delta);
    const dec = await db.assistLearningSpend.updateMany({
      where: { siteId, period, spentMicroUsd: { gte: back } },
      data: { spentMicroUsd: { decrement: back } },
    });
    if (dec.count > 0) return;
    await db.assistLearningSpend.updateMany({
      where: { siteId, period, spentMicroUsd: { lt: back } },
      data: { spentMicroUsd: BigInt(0) },
    });
  }

  async status(
    accountId: string,
    siteId: string,
  ): Promise<LearningBudgetStatus> {
    const period = budgetPeriod(this.now());
    const [share, row] = await Promise.all([
      this.share(accountId, siteId),
      this.sitesDb.forAccount(accountId).assistLearningSpend.findFirst({
        where: { siteId, period },
        select: { spentMicroUsd: true },
      }),
    ]);
    return {
      period,
      capMicroUsd: share,
      spentMicroUsd: Number(row?.spentMicroUsd ?? 0),
    };
  }
}
