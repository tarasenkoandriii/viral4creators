/**
 * Голосовое управление «Сайтом» — ленивый чанк загрузчика `act.js` (Э6-бис
 * (а), ТЗ §5-бис.3; бюджет — scripts/size-budget.mjs, загрузчик 12 КБ не
 * растёт). Грузится только когда iframe попросил снимок или исполнение
 * плана — а это бывает только после речи или набора в iframe.
 *
 * Исполняется в origin ЗАКАЗЧИКА, поэтому правила загрузчика: никаких
 * HTML-приёмников (createElement/textContent/CSSOM), никаких фоновых
 * запросов — только сообщения своему iframe через загрузчик. Команды
 * загрузчик передаёт сырыми — разбор строгий здесь (`parseUiCommand`).
 */
import type { ParentMessage } from '../shared/protocol';
import { parseUiCommand } from '../shared/ui-plan';
import { mem, Runner, type ActNatives } from './exec';
import { takeSnapshot } from './snapshot';

export interface ActHost {
  N: ActNatives;
  /** Сообщение своему iframe (targetOrigin — origin виджета). */
  post(m: ParentMessage): void;
  /** Свернуть окно чата на телефоне. */
  min(): void;
  /** Флаг «план идёт» в состоянии окна (iframe поднимется на новой странице). */
  mark(on: boolean): void;
}

export interface ActApi {
  on(raw: Record<string, unknown>): void;
}

export function start(host: ActHost): ActApi {
  let refs = new Map<string, Element>();
  let deny: string[] = [];
  let allow: string[] = [];
  let runner: Runner | null = null;
  return {
    on(raw) {
      // (д) «Вернуть»: прежние значения полей — из памяти этой страницы;
      // возврат — ленивый чанк своего выпуска (act.js не растёт).
      if (raw.type == 'ui-undo')
        return void import(
          /* @vite-ignore */ new URL('undo.js', import.meta.url).href
        ).then((x: { undo: (r: unknown, m: unknown, h: ActHost) => void }) =>
          x.undo(raw, mem, host)
        );
      const m = parseUiCommand(raw);
      if (!m) return;
      switch (m.type) {
        case 'ui-snap': {
          deny = m.deny;
          allow = m.allow;
          const s = takeSnapshot(deny, allow);
          refs = s.refs;
          host.post({ type: 'ui-snapshot', rid: m.rid, snapshot: s.snapshot });
          return;
        }
        case 'ui-run': {
          if (runner && !runner.stopped) runner.stop(null);
          const r = new Runner(
            {
              N: host.N,
              refs,
              deny,
              allow,
              min: host.min,
              mark: host.mark,
              report: (index, result, reason, ms) =>
                host.post({
                  type: 'ui-step',
                  planId: m.planId,
                  index,
                  result,
                  reason,
                  url: location.href.split('#')[0],
                  ms,
                }),
              stopped: (by) =>
                host.post({ type: 'ui-stopped', planId: m.planId, by }),
              need: (index) =>
                host.post({ type: 'ui-need', planId: m.planId, index }),
            },
            m.planId,
            m.steps,
            m.from,
            m.lang
          );
          runner = r;
          // Продолжение на новой странице: первый шаг — `dispatched`.
          void r.run(m.steps[m.from] && m.steps[m.from].state === 'dispatched');
          return;
        }
        case 'ui-ack':
          if (runner && runner.planId === m.planId) runner.ack(m.index);
          return;
        case 'ui-stop':
          if (runner && runner.planId === m.planId) runner.stop(null);
          return;
        case 'ui-pause':
          if (runner) runner.pause(m.on);
          return;
      }
    },
  };
}
