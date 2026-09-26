/**
 * Где человек находился в момент находки (этап 160,
 * `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §3.8).
 *
 * ## Зачем контекст, а не адресная строка
 *
 * Весь смысл второго входа — в том, что сессия и шаг подставляются
 * САМИ. Кнопка живёт в подвале, то есть снаружи мастера, а адрес о
 * сессии не знает вовсе: у мастера товарки маршрут `#/generate` без
 * единого параметра, а `sessionId` живёт в состоянии экрана.
 *
 * Поэтому экран, который знает, где человек, сам об этом сообщает, а
 * подвал только читает. Направление важно: обратное (подвал лезет в
 * состояние мастера) связало бы их намертво.
 *
 * ## Почему «последнее известное», а не «текущее»
 *
 * Человек мог уйти с шага на «Проекты» и только там сообразить, что
 * надо написать. Затирать место находки при каждом уходе значило бы
 * терять его ровно тогда, когда оно и нужно; поэтому значение живёт,
 * пока экран не сообщит другое.
 */

import { createContext, useContext, useEffect } from 'react';

export interface ReportLocation {
  sessionId: string | null;
  stepId: string | null;
}

export interface ReportLocationValue extends ReportLocation {
  report: (where: ReportLocation) => void;
}

export const ReportLocationContext = createContext<ReportLocationValue>({
  sessionId: null,
  stepId: null,
  report: () => {},
});

export function useReportLocation(): ReportLocationValue {
  return useContext(ReportLocationContext);
}

/**
 * Экран сообщает, где он. Вызывать можно безусловно: пустые значения
 * ничего не затирают — незачем терять место находки из-за того, что
 * мастер на секунду остался без сессии.
 */
export function useReportHere(
  sessionId: string | null | undefined,
  stepId: string | null | undefined
): void {
  const { report } = useReportLocation();
  useEffect(() => {
    if (!sessionId) return;
    report({ sessionId, stepId: stepId ?? null });
  }, [report, sessionId, stepId]);
}
