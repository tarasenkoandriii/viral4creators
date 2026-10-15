import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseGenerated } from './generated-contract';
import { checkStand, mockTransition, type StandRecord } from './stand-contract';
const source = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../assist/src/lib/qa-tiktok-mock.json'),
    'utf8',
  ),
);
const contract = () => parseGenerated(source, source.description);
describe('TikTok synthetic preset', () => {
  it('parses and passes isolated engine checks', () => {
    const c = contract();
    expect(c.entities).toHaveLength(4);
    expect(checkStand(c).checks.filter((x) => !x.passed)).toEqual([]);
  });
  it('rejects unsafe URLs and real credentials; generates MOCK credentials', () => {
    const c = contract();
    const app = [
      'QA',
      'Synthetic',
      'placeholder',
      'https://example.invalid',
      'https://example.invalid/privacy',
      'https://example.invalid/terms',
      'https://example.invalid/callback',
      'draft',
    ];
    expect(
      mockTransition(c, [], {
        method: 'POST',
        entityId: 'apps',
        role: 'admin',
        values: app.map((v, i) => (i === 3 ? 'javascript:alert(1)' : v)),
      }).status,
    ).toBe(422);
    const settings = [
      'QA',
      'web',
      'video.upload + video.publish',
      'tester',
      'ready',
      '',
      '',
      'inactive',
    ];
    expect(
      mockTransition(c, [], {
        method: 'POST',
        entityId: 'settings',
        role: 'admin',
        values: settings.map((v, i) => (i === 5 ? 'real-secret' : v)),
      }).status,
    ).toBe(422);
    const r = mockTransition(c, [], {
      method: 'POST',
      entityId: 'settings',
      role: 'admin',
      values: settings,
    });
    expect(r.status).toBe(201);
    const row = r.records[0];
    expect(row.values[5]).toMatch(/^MOCK_KEY_/);
    expect(row.values[6]).toMatch(/^MOCK_SECRET_/);
    expect(
      mockTransition(c, r.records, {
        method: 'TRANSITION',
        entityId: 'settings',
        role: 'admin',
        id: row.id,
        expectedVersion: row.version,
        transitionId: 'issue',
      }).status,
    ).toBe(409);
  });
  it('bounds synthetic media metadata', () => {
    const c = contract();
    for (const size of ['0', '101']) {
      expect(
        mockTransition(c, [], {
          method: 'POST',
          entityId: 'assets',
          role: 'admin',
          values: ['clip', 'clip.mp4', 'mp4', size, '30', 'draft'],
        }).status,
      ).toBe(422);
    }
  });
});

describe('TikTok complete workflow', () => {
  it('simulates publication, rotates keys and invalidates dependencies after edits', () => {
    const c = contract();
    let rows: StandRecord[] = [];
    const call = (
      entityId: string,
      method: string,
      args: object = {},
      role = 'admin',
    ) => {
      const result = mockTransition(c, rows, {
        entityId,
        method,
        role,
        ...args,
      });
      rows = result.records;
      return result;
    };
    const create = (entity: string, values: string[]) => {
      const r = call(entity, 'POST', { values });
      expect(r.status).toBe(201);
      return (r.data as StandRecord).id;
    };
    const row = (id: string) => rows.find((x) => x.id === id)!;
    const transition = (
      entity: string,
      id: string,
      transitionId: string,
      role = 'admin',
    ) =>
      call(
        entity,
        'TRANSITION',
        { id, transitionId, expectedVersion: row(id).version },
        role,
      );
    const app = create('apps', [
      'QA',
      'Synthetic',
      'placeholder',
      'https://example.invalid',
      'https://example.invalid/privacy',
      'https://example.invalid/terms',
      'https://example.invalid/callback',
      'draft',
    ]);
    const config = create('settings', [
      'QA',
      'web',
      'video.upload + video.publish',
      'tester',
      'ready',
      '',
      '',
      'inactive',
    ]);
    expect(transition('settings', config, 'issue').status).toBe(409);
    expect(transition('apps', app, 'submit').status).toBe(200);
    expect(transition('apps', app, 'approve', 'editor').status).toBe(403);
    expect(transition('apps', app, 'approve').status).toBe(200);
    expect(transition('settings', config, 'issue').status).toBe(200);
    const staleVersion = row(config).version;
    const keys = row(config).values.slice(5, 7);
    expect(transition('settings', config, 'rotate').status).toBe(200);
    expect(row(config).values.slice(5, 7)).not.toEqual(keys);
    expect(
      call('settings', 'TRANSITION', {
        id: config,
        transitionId: 'rotate',
        expectedVersion: staleVersion,
      }).status,
    ).toBe(409);
    const media = create('assets', [
      'clip',
      'clip.mp4',
      'mp4',
      '10',
      '30',
      'draft',
    ]);
    for (const step of ['upload', 'fail', 'retry', 'process', 'ready'])
      expect(transition('assets', media, step).status).toBe(200);
    const video = create('videos', [
      'video',
      'QA',
      'clip',
      'Synthetic caption',
      'private',
      'pass',
      '2026-10-16T12:00',
      'draft',
    ]);
    expect(transition('videos', video, 'approve').status).toBe(200);
    expect(transition('videos', video, 'schedule', 'editor').status).toBe(200);
    expect(transition('videos', video, 'publish').status).toBe(200);
    expect(row(video).values[7]).toBe('simulated_published');
    expect(transition('videos', video, 'publish').status).toBe(409);
    const originalRows = rows;
    const original = JSON.stringify(rows);
    const changed = [...row(config).values];
    changed[3] = 'new tester';
    expect(
      call('settings', 'PATCH', {
        id: config,
        expectedVersion: row(config).version,
        values: changed,
      }).status,
    ).toBe(200);
    expect(JSON.stringify(originalRows)).toBe(original);
    expect(row(app).values[7]).toBe('draft');
    expect(row(video).values[7]).toBe('draft');
    expect(row(video).approvalDigest).toBeUndefined();
    expect(transition('videos', video, 'approve').status).toBe(409);
    expect(JSON.stringify(rows)).not.toBe(original);
  });
});
