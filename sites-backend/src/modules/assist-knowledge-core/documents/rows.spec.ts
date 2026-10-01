import { versionView } from './rows';

const row = (stats: unknown) =>
  ({
    number: 3,
    status: 'building',
    trigger: 'crawl',
    stats,
    gateReport: null,
    heldReason: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    publishedAt: null,
  }) as unknown as Parameters<typeof versionView>[0];

describe('versionView: прогресс сборки наружу — только cursor/total', () => {
  it('очередь, удаления, хеши и захват строящейся версии не уходят в кабинет', () => {
    const queue = Array.from(
      { length: 2000 },
      (_, i) => `https://shop.example.com/p/${i}`,
    );
    const v = versionView(
      row({
        added: 5,
        chunks: 40,
        build: {
          v: 1,
          queue,
          hot: [1, 2],
          removals: [{ ref: 'x' }],
          changedHashes: { abc: 1 },
          claim: 'tick-1',
          cursor: 120,
          total: 2000,
        },
      }),
      2,
      new Set(),
    );
    expect(v.stats).toEqual({
      added: 5,
      chunks: 40,
      build: { cursor: 120, total: 2000 },
    });
    expect(JSON.stringify(v).length).toBeLessThan(1000);
  });

  it('без build — stats как есть; мусор в build — нули', () => {
    expect(versionView(row({ added: 1 }), 3, new Set()).stats).toEqual({
      added: 1,
    });
    expect(versionView(row({ build: 'x' }), 3, new Set()).stats).toEqual({
      build: { cursor: 0, total: 0 },
    });
    expect(versionView(row(null), 3, new Set()).stats).toEqual({});
  });
});
