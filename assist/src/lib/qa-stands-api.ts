import type { ApiClient } from '../kit';
export interface StandContract {
  title: string;
  description: string;
  fields: string[];
  template: 'records' | 'generated';
  version: 1 | 2;
  entities?: Array<{
    id: string;
    title: string;
    fields: Array<{
      name: string;
      type: 'text' | 'number' | 'email' | 'select';
      required: boolean;
      options: string[];
    }>;
  }>;
  screens?: Array<{
    id: string;
    title: string;
    kind: 'list' | 'form' | 'dashboard';
    entityId: string;
    nextScreenId: string | null;
  }>;
  assumptions?: string[];
}
export interface Stand {
  id: string;
  contract: StandContract;
  records: Array<{ id: string; values: string[]; entityId?: string }>;
  revision: number;
}
export interface MockResult {
  status: number;
  data: unknown;
  revision: number;
}
export function createQaStandsApi(client: ApiClient) {
  const base = (site: string) => `/qa/sites/${encodeURIComponent(site)}/stands`;
  return {
    list: (site: string, before?: string) =>
      client.request(
        'GET',
        base(site) + (before ? `?before=${encodeURIComponent(before)}` : '')
      ) as Promise<{ items: Stand[] }>,
    get: (site: string, id: string) =>
      client.request(
        'GET',
        base(site) + `/${encodeURIComponent(id)}`
      ) as Promise<Stand>,
    remove: (site: string, id: string) =>
      client.request('DELETE', base(site) + `/${encodeURIComponent(id)}`),
    generate: (site: string, description: string, title?: string) =>
      client.request('POST', base(site) + '/generate', {
        description,
        title,
      }) as Promise<StandContract>,
    voice: (site: string, audio: string) =>
      client.request('POST', base(site) + '/voice', { audio }) as Promise<{
        text: string;
        language: string | null;
        confidence: number | null;
      }>,
    plan: (site: string, description: string, title: string) =>
      client.request('POST', base(site) + '/plan', {
        description,
        title,
      }) as Promise<StandContract>,
    create: (site: string, contract: StandContract, requestId: string) =>
      client.request('POST', base(site), {
        ...contract,
        requestId,
      }) as Promise<Stand>,
    command: (site: string, id: string, body: unknown) =>
      client.request(
        'POST',
        base(site) + `/${encodeURIComponent(id)}/mock`,
        body
      ) as Promise<MockResult>,
    check: (site: string, id: string) =>
      client.request(
        'POST',
        base(site) + `/${encodeURIComponent(id)}/check`
      ) as Promise<{
        scope: string;
        checks: Array<{ name: string; passed: boolean }>;
      }>,
    reset: (site: string, id: string) =>
      client.request(
        'POST',
        base(site) + `/${encodeURIComponent(id)}/reset`
      ) as Promise<MockResult>,
  };
}
