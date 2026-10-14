import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cabinetHttp,
  loadSegments,
  main,
  parseArgs,
  parseAuthHeaders,
} from '../cli/reddit-import';
import { buildImportPlan, runImport, type ImportHttp } from './research-import';

describe('Reddit import boundaries', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reddit-audit-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('allows absent companions but never treats unreadable input as empty research', () => {
    writeFileSync(join(dir, 'smb-communities.csv'), 'name\nr/SaaS\n');
    expect(loadSegments(dir, null)[0].keywords).toEqual([]);
    mkdirSync(join(dir, 'smb-keywords.csv'));
    expect(() => loadSegments(dir, null)).toThrow('CSV');
  });

  it('fails before API calls on malformed CSV without printing file contents', async () => {
    writeFileSync(
      join(dir, 'smb-communities.csv'),
      'name\n"private malformed text',
    );
    const error = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const fetcher = jest.fn();
    try {
      const result = await main(
        ['--dir', dir, '--project-title', 'Audit'],
        {},
        fetcher,
      );
      expect(result.code).toBe(1);
      expect(fetcher).not.toHaveBeenCalled();
      expect(JSON.stringify(error.mock.calls)).not.toContain(
        'private malformed text',
      );
    } finally {
      error.mockRestore();
    }
  });

  it('rejects credentials and Reddit hostname aliases before sending session headers', () => {
    for (const url of [
      'https://user:secret@example.com',
      'https://example.com?token=secret',
      'https://example.com#secret',
      'https://www.reddit.com.',
      'https://i.redditstatic.com',
    ])
      expect(() =>
        parseArgs([
          '--project-title',
          'Audit',
          '--base-url',
          url,
          '--product',
          'pid',
        ]),
      ).toThrow();
  });

  it('never includes untrusted header names in diagnostics', () => {
    let message = '';
    try {
      parseAuthHeaders(JSON.stringify({ 'Cookie secret-value': 'other' }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('недопустимый заголовок');
    expect(message).not.toContain('secret-value');
  });

  it('bounds API requests and forbids redirect forwarding', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValue({ status: 200, json: async () => ({ data: [] }) });
    await cabinetHttp('https://example.com', {}, fetcher).get(
      '/publisher/products/pid',
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
  });

  it.each([401, 403])(
    'stops an apply run when write authorization fails: %s',
    async (status) => {
      const post = jest
        .fn()
        .mockResolvedValue({ status, body: { error: { code: 'FORBIDDEN' } } });
      const http: ImportHttp = {
        get: async (path) => ({
          status: 200,
          body: {
            data:
              path === '/publisher/products/pid'
                ? { features: { reddit: true } }
                : { items: [], nextBefore: null },
          },
        }),
        post,
      };
      const plan = buildImportPlan([], {
        projectTitle: 'Audit',
        locale: 'en',
        market: 'global',
        now: new Date(),
      });
      await expect(runImport(http, 'pid', plan, true)).rejects.toThrow(
        `HTTP ${status}`,
      );
      expect(post).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['cycle', 'limit', 'shape'])(
    'never returns an incomplete existing registry: %s',
    async (mode) => {
      let pages = 0;
      const post = jest.fn();
      const http: ImportHttp = {
        get: async (path) =>
          path === '/publisher/products/pid'
            ? { status: 200, body: { data: { features: { reddit: true } } } }
            : {
                status: 200,
                body: {
                  data:
                    mode === 'shape'
                      ? null
                      : {
                          items: [],
                          nextBefore:
                            mode === 'cycle' ? 'same' : `page-${++pages}`,
                        },
                },
              },
        post,
      };
      const plan = buildImportPlan([], {
        projectTitle: 'Audit',
        locale: 'en',
        market: 'global',
        now: new Date(),
      });
      await expect(runImport(http, 'pid', plan, true)).rejects.toThrow(
        'IMPORT_',
      );
      expect(post).not.toHaveBeenCalled();
    },
  );
});
