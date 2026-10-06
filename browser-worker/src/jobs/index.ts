import type { BrowserJobKind } from '../shared/browser-job-protocol';
import { runAdminCrawl } from './admin-crawl';
import { runDescriptorResolve } from './descriptor-resolve';
import { runFramesCapture } from './frames-capture';
import type { JobExecutor } from './types';
import { runUiSnapshot } from './ui-snapshot';

export const EXECUTORS: Readonly<Record<BrowserJobKind, JobExecutor>> = {
  'ui-snapshot': runUiSnapshot,
  'descriptor-resolve': runDescriptorResolve,
  'admin-crawl': runAdminCrawl,
  'frames-capture': runFramesCapture,
};
