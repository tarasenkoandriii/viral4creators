import type { ApiClient } from '../kit';
export interface StandContract {
  title: string;
  description: string;
  fields: string[];
  template: 'records';
  version: 1;
}
export interface Stand {
  id: string;
  contract: StandContract;
  records: Array<{ id: string; values: string[] }>;
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
