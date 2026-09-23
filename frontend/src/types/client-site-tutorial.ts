/**
 * Обучалка по сайту заказчика — типы ответов визарда
 * (doc/CLIENT-SITE-TUTORIAL-SPEC.md §5.2/§5.4/§6.1, этап 115).
 *
 * Ручная копия серверных типов, как и остальные типы этого каталога:
 * общего пакета между `backend/` и `frontend/` в проекте нет, и
 * заводить его ради одной фичи — отдельное решение, не это. Поля здесь
 * обязаны совпадать с `client-site-tutorial.service.ts`; расхождение
 * поймает `tsc` на первом же использовании.
 */

import type { Readiness } from './index';

export type ClientSiteDraftStatus =
  | 'DRAFTING'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'REJECTED';

export interface PageElement {
  /** Стабильный CSS-селектор, построенный сервером (§5.4). Фронтенд его
   * не разбирает и не строит — только возвращает обратно. */
  selector: string;
  tag: 'input' | 'select' | 'textarea' | 'button' | 'a';
  type?: string;
  label?: string;
  visibleText?: string;
  name?: string;
  /** Предупреждение стоп-листа §8.3 — приходит РАНЬШЕ, чем пользователь
   * нажмёт кнопку, поэтому «вы уверены?» успевает спроситься до того,
   * как шаг выполнится на настоящем сайте. */
  danger?: string;
  /** Варианты `<select>`: `fill` сопоставляет строку со ЗНАЧЕНИЕМ
   * опции, а не с надписью, — угадать его из интерфейса нельзя. */
  options?: Array<{ value: string; label: string }>;
}

export interface PageExploration {
  currentUrl: string;
  /** `data:image/jpeg;base64,…` — не ссылка (§6.3). */
  screenshotDataUrl: string;
  elements: PageElement[];
  /** На странице видно поле пароля — визард зовёт `/login`, а не `/step`. */
  looksLikeLogin: boolean;
  dangerWarning?: string;
}

export interface ClientSiteDraftView {
  id: string;
  projectId: string;
  baseUrl: string;
  steps: unknown[];
  /** Сколько шагов дописал каждый РАУНД. Длина равна длине
   * `roundScreenshots`, но НЕ длине `steps`: один раунд может дописать
   * несколько шагов, а кадр даёт ровно один (§15 п.3). */
  stepsPerRound: number[];
  roundScreenshots: string[];
  lastUrl: string | null;
  requiresLiveLoginReplay: boolean;
  status: ClientSiteDraftStatus;
  title: string | null;
  rejectionReason: string | null;
  previewFrameCount: number | null;
  version: number;
  hasCredentials: boolean;
  /** §15.8 контракта реле: кнопка живого входа прячется по ЭТОМУ
   * признаку, а не по тексту ошибки после нажатия. */
  liveLoginAvailable: boolean;
  /** Чего не хватает до готового ролика («Тонкая красная линия» §7). */
  readiness: Readiness;
  /** Собранный ролик — только у одобренного черновика (находка Б-4
   * аудита `docs-tz/AUDIT-Client-Site-Tutorial-Landing.md`). До этого
   * визард заканчивался строкой «ролик собирается», после которой не
   * появлялось ничего. */
  video: ClientSiteTutorialVideo | null;
}

export interface ClientSiteTutorialVideo {
  status: 'pending' | 'complete' | 'failed';
  /** Заполнена только при `status === 'complete'` — сервер намеренно не
   * отдаёт ссылку у провалившейся сборки, где она может указывать на
   * обрывок прошлой попытки. */
  url: string | null;
  durationMs: number | null;
}

export interface ClientSiteRoundResult {
  draft: ClientSiteDraftView;
  exploration: PageExploration;
}

export interface LiveLoginStart {
  sessionId: string;
  streamToken: string;
  relayWsUrl: string;
  /** Зашифрованная квитанция — её, а не `sessionId`, визард возвращает
   * в `/live-login/complete`. */
  ticket: string;
}
