/**
 * Стенд P-E для db/http-тестов: ядро (`coreStack`) + модуль отчётов с
 * НАСТОЯЩИМИ `PilotClockPort` и шагом `pilot-experiment` (фейки P-A1 этих
 * двух `coreStack` убирает сам — `fakesBesides`, интеграция Z-1),
 * хранилище копий — в памяти.
 */
import {
  coreStack,
  type CoreStack,
} from '../../core/testing/core-stack.testing';
import { BackupService } from '../backup.service';
import { PublisherReportsModule } from '../reports.module';
import { MemoryBackupStorage } from './memory-backup-storage.testing';

export interface ReportsStack extends CoreStack {
  mem: MemoryBackupStorage;
}

export async function reportsStack(
  opts: { http?: boolean } = {},
): Promise<ReportsStack> {
  const s = await coreStack({
    http: opts.http,
    imports: [PublisherReportsModule],
  });
  const mem = new MemoryBackupStorage();
  (
    s.mod.get(BackupService) as unknown as { storage: MemoryBackupStorage }
  ).storage = mem;
  return { ...s, mem };
}
