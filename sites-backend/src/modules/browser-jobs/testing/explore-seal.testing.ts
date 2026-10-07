/**
 * Конверт сессии раунда обучалки для спеков каналов (Ш3-хвост (3)):
 * `browser-jobs/worker-seal` за пределами очереди и канала воркера не
 * импортируется (правило графа `worker-seal-private`) — спеки канала
 * генератора берут ключи и конверт отсюда.
 */
import {
  exploreFillAad,
  exploreSessionAad,
  type ExploreAadParts,
} from '../protocol';
import { generateWorkerSealKeys, sealForWorker } from '../worker-seal';

export function workerKeysForTests(): {
  publicKey: string;
  privateKey: string;
} {
  return generateWorkerSealKeys();
}

export function sealSessionForTests(
  publicKey: string,
  jar: Buffer,
  parts: ExploreAadParts,
): string {
  return sealForWorker(publicKey, jar, exploreSessionAad(parts));
}

export function sealFillForTests(
  publicKey: string,
  value: string,
  parts: ExploreAadParts,
  index: number,
): string {
  return sealForWorker(
    publicKey,
    Buffer.from(value),
    exploreFillAad(parts, index),
  );
}
