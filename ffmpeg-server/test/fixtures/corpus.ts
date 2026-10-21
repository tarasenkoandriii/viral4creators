import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobRequestBody } from '../../src/contracts';

export interface CorpusEntry {
  id: string;
  product: string;
  source: string;
  callSite: string;
  note: string;
  live: boolean;
  request: JobRequestBody;
  textInputs: Record<string, string>;
}

export function loadCorpus(): CorpusEntry[] {
  const raw = readFileSync(join(__dirname, 'command-corpus.json'), 'utf8');
  return (JSON.parse(raw) as { entries: CorpusEntry[] }).entries;
}
