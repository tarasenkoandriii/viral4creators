import { withCronLock } from './cron-job-lock';
import type { PrismaService } from '../prisma/prisma.service';
it('partial failure retains result and records error when releasing its own lock', async () => {
  const db = {
    $queryRawUnsafe: jest.fn(
      async (_sql: string, _key: string, holder: string) => [{ holder }],
    ),
    $executeRawUnsafe: jest.fn(async () => 1),
  };
  const result = {
    filesError: 'sensitive upstream message',
    index: { failed: 1 },
  };
  expect(
    await withCronLock(
      db as unknown as PrismaService,
      'assist-embed-run',
      1000,
      async () => result,
    ),
  ).toEqual({ ran: true, result });
  const acquire = db.$queryRawUnsafe.mock.calls[0];
  expect(db.$executeRawUnsafe).toHaveBeenCalledWith(
    expect.any(String),
    'assist-embed-run',
    acquire[2],
    'PartialFailure: files, index',
  );
});
