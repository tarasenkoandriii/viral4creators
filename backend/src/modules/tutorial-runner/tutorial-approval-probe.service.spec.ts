/* eslint-disable @typescript-eslint/no-explicit-any -- explicit isolated doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { ForbiddenException } from '@nestjs/common';
import { TutorialApprovalProbeService } from './tutorial-approval-probe.service';
import { TutorialVideoAdminController } from './tutorial-video-admin.controller';

it('requires an operator before the live probe can run', async () => {
  const probe = { run: jest.fn() };
  const admin = {
    assertOperator: jest.fn().mockRejectedValue(new ForbiddenException()),
  };
  const controller = new TutorialVideoAdminController(
    admin as any,
    {} as any,
    {} as any,
    {} as any,
    undefined,
    probe as any,
  );
  await expect(
    controller.verifyExactApproval({ userId: 'viewer' } as any),
  ).rejects.toThrow(ForbiddenException);
  expect(probe.run).not.toHaveBeenCalled();
});
it('cleans only its generated fixture paths even when the upload fails', async () => {
  const prisma = { $transaction: jest.fn() };
  const blob = {
    uploadBuffer: jest.fn().mockRejectedValue(new Error('upload failed')),
    deleteMany: jest.fn().mockResolvedValue(2),
  };
  const service = new TutorialApprovalProbeService(prisma as any, blob as any);
  await expect(service.run('operator')).rejects.toThrow('upload failed');
  expect(prisma.$transaction).not.toHaveBeenCalled();
  const paths = blob.deleteMany.mock.calls[0][0] as string[];
  expect(paths).toHaveLength(2);
  expect(
    paths.every((p) =>
      /^tutorial-videos\/qa-approval-[a-f0-9-]+\/(first|replacement)\.mp4$/.test(
        p,
      ),
    ),
  ).toBe(true);
});
