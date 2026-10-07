/**
 * Строка прогресса замера: что идёт, сколько сделано, сколько осталось по
 * времени, сколько потрачено, сколько пустых ответов, сколько длился
 * последний вызов. Печатается в stderr всегда (без --verbose прогон
 * иначе молчит минутами), не чаще раза в `everyMs` и на последнем шаге.
 */
import { formatMicroUsd } from '../../src/common/ai-pricing';
import type { ProgressEvent, RunHooks } from './runner';

const clock = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function progressLine(e: ProgressEvent, elapsedMs: number): string {
  const left =
    e.done > 0 ? ((e.total - e.done) * elapsedMs) / e.done : Number.NaN;
  return (
    `[${e.stage}] ${e.done}/${e.total}` +
    ` · прошло ${clock(elapsedMs)}` +
    (Number.isFinite(left) ? ` · осталось ~${clock(left)}` : '') +
    ` · потрачено ${formatMicroUsd(e.spentMicro)}` +
    (e.empty ? ` · пустых ответов ${e.empty}` : '') +
    ` · последний вызов ${(e.lastMs / 1000).toFixed(1)} с`
  );
}

export function consoleHooks(
  write: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
  everyMs = 5_000,
  now: () => number = Date.now,
): RunHooks {
  const stageStart = new Map<string, number>();
  let lastPrinted = 0;
  return {
    waitEveryMs: 20_000,
    progress(e) {
      const t = now();
      if (!stageStart.has(e.stage)) {
        stageStart.set(e.stage, t - e.lastMs);
        write(`Начинаю: ${e.stage}, ${e.total} вызовов.`);
      }
      if (e.done === e.total || e.done === 1 || t - lastPrinted >= everyMs) {
        lastPrinted = t;
        write(progressLine(e, t - stageStart.get(e.stage)!));
      }
    },
    waiting(stage, label, ms) {
      write(
        `[${stage}] ждём ответ на ${label} уже ${Math.round(ms / 1000)} с — сеть или провайдер медлят` +
          (ms >= 60_000
            ? '; если так и дальше — Ctrl+C и проверьте сеть/ключ'
            : ''),
      );
    },
  };
}
