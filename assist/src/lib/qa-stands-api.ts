import type { ApiClient } from '../kit';
/** Disabled workflow fields are derived from the contract/original record, never a cleared form slot. */
export function standFormValues(
  fields: Array<{ name: string; generated?: 'mock-key' | 'mock-secret' }>,
  values: string[],
  workflow?: { stateField: string; initial: string },
  original?: string[]
) {
  return fields.map((f, i) =>
    f.generated
      ? (original?.[i] ?? '')
      : workflow?.stateField === f.name
        ? (original?.[i] ?? workflow.initial)
        : (values[i] ?? '')
  );
}
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
      type: 'text' | 'number' | 'email' | 'select' | 'url' | 'datetime';
      required: boolean;
      options: string[];
      generated?: 'mock-key' | 'mock-secret';
      min?: number;
      max?: number;
      unique?: boolean;
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
  workflows?: Array<{
    entityId: string;
    stateField: string;
    initial: string;
    invalidateRelatedOnEdit?: boolean;
    transitions: Array<{
      id: string;
      title: string;
      from: string[];
      to: string;
      roles: Array<'editor' | 'admin'>;
      conditions: Array<{
        field: string;
        equals: string;
        related?: { entityId: string; viaField: string; matchField: string };
      }>;
      seal: boolean;
      requireSeal: boolean;
      rotateCredentials?: boolean;
    }>;
  }>;
}
export interface Stand {
  id: string;
  contract: StandContract;
  records: Array<{
    id: string;
    values: string[];
    entityId?: string;
    version?: number;
  }>;
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
    command: (site: string, id: string, body: unknown) => {
      const path = base(site) + `/${encodeURIComponent(id)}/mock`;
      const command = body as {
        method?: string;
        entityId?: string;
        query?: string;
        scenario?: string;
      };
      if (command?.method === 'GET') {
        const query = new URLSearchParams();
        if (command.entityId) query.set('entity', command.entityId);
        if (command.query) query.set('q', command.query);
        if (command.scenario) query.set('scenario', command.scenario);
        return client.request(
          'GET',
          path + (query.size ? `?${query}` : '')
        ) as Promise<MockResult>;
      }
      return client.request('POST', path, body) as Promise<MockResult>;
    },
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
