/**
 * Реестр обработчиков результата по источнику задания (Э-С Ш3). Очередь
 * (`browser-jobs`) не импортирует продукты (правило графа
 * `browser-jobs-neutral`): продукт сам регистрирует, что делать с итогом
 * своего задания, в `onModuleInit` своего модуля.
 */
import { Injectable } from '@nestjs/common';
import type { BrowserJobOrigin } from './browser-job-rules';
import type {
  BrowserJobKind,
  BrowserJobParams,
  BrowserJobResult,
} from './protocol';

export interface HandlerJob {
  id: string;
  accountId: string;
  siteId: string;
  hostId: string;
  kind: BrowserJobKind;
  origin: BrowserJobOrigin;
  refId: string | null;
  params: BrowserJobParams;
  testAccountId: string | null;
}

export interface BrowserJobHandler {
  /** Воркер взял задание (первая или повторная попытка). */
  onStarted?(job: HandlerJob): Promise<void>;
  /**
   * Результат принят (уже разобран строго). Продукт пишет своё; возвращает
   * то, что хранить в `site_browser_jobs.result` (может урезать: тексты
   * страниц «Админки» живут в `assist_admin_pages`, не в очереди).
   */
  onDone?(job: HandlerJob, result: BrowserJobResult): Promise<unknown>;
  /** Задание окончательно не выполнено (без повтора) или отменено. */
  onFailed?(job: HandlerJob, code: string): Promise<void>;
  /**
   * Сверка продукта с очередью (аудит Ш3, P2): крон `browser-jobs-reap`
   * зовёт её после своих шагов — записи продукта, которые всё ещё «идут»,
   * хотя их задание уже кончилось (функция оборвалась между переходом
   * задания и обработчиком) или пропало, продукт доводит сам. Возвращает
   * число исправленных записей.
   */
  reconcile?(now: Date): Promise<number>;
}

@Injectable()
export class BrowserJobHandlers {
  private readonly map = new Map<BrowserJobOrigin, BrowserJobHandler>();

  register(origin: BrowserJobOrigin, h: BrowserJobHandler): void {
    this.map.set(origin, h);
  }

  get(origin: BrowserJobOrigin): BrowserJobHandler | null {
    return this.map.get(origin) ?? null;
  }

  all(): Array<[BrowserJobOrigin, BrowserJobHandler]> {
    return [...this.map];
  }
}
