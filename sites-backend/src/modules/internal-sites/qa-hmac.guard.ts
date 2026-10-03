/**
 * Гвард внутреннего API Flow-QA для карты интерфейса (Э-С Ш4) — та же
 * подпись, что у обучалки (`TutorialHmacGuard`: HMAC тела с меткой времени
 * и id, журнал id против повтора, тело строкой), но СВОЙ секрет
 * `SITES_QA_HMAC_SECRET` и свой вызывающий `qa-flow` (П-С3: «отдельный
 * секрет на направление» — утечка секрета обучалки не открывает карту QA
 * и наоборот). Нет секрета или он совпал с секретом обучалки — маршруты
 * закрыты (503).
 */
import { Injectable } from '@nestjs/common';
import { TutorialHmacGuard } from './tutorial-hmac.guard';

/** Вызывающий Flow-QA (часть подписи, как `generator-tutorial` у обучалки). */
export const SITES_CALLER_QA = 'qa-flow';

@Injectable()
export class QaHmacGuard extends TutorialHmacGuard {
  protected readonly secretEnv: string = 'SITES_QA_HMAC_SECRET';
  protected readonly caller: string = SITES_CALLER_QA;
  protected readonly product: string = 'Flow-QA';
  protected readonly distinctFromEnv: string | null =
    'SITES_TUTORIAL_HMAC_SECRET';
}
