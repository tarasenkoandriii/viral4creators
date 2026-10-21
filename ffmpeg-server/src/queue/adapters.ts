/**
 * Реальные реализации портов — модули пакета EXEC. Диспетчер и API
 * видят только интерфейсы ports.ts; тесты подставляют фейки.
 */
import { parseJob } from '../command/parse';
import type { ServerConfig } from '../config';
import { downloadInput } from '../download/download';
import { checkSourceUrl } from '../download/url-policy';
import { ExecutorClient } from '../executor/client';
import { checkInputLimits } from '../probe/limits';
import { verifyOutputs } from '../probe/outputs';
import type { Ports } from './ports';

export function realPorts(
  cfg: Pick<ServerConfig, 'workspaceRoot'>,
  executor: ExecutorClient = new ExecutorClient({
    workspaceRoot: cfg.workspaceRoot,
  }),
): Ports {
  return {
    parseJob: (body, limits) => parseJob(body, limits),
    checkSourceUrl: (url, hosts, opts) => checkSourceUrl(url, hosts, opts),
    downloadInput: (url, dest, opts) => downloadInput(url, dest, opts),
    checkInputLimits: (probe, limits) => checkInputLimits(probe, limits),
    verifyOutputs: (dir, outputs, limits, opts) =>
      verifyOutputs(dir, outputs, limits, opts),
    executor,
  };
}
