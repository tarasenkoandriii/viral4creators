jest.mock('./admin-panel.service', () => ({ AdminPanelService: class {} }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }), {
  virtual: true,
});
import { AdminSonioxController } from './admin-soniox.controller';
describe('global Soniox dashboard permissions and partial availability', () => {
  const make = () => {
    const admin = { assertOperator: jest.fn().mockResolvedValue(undefined) },
      telemetry = { report: jest.fn().mockResolvedValue({ available: true }) },
      assist = { call: jest.fn().mockResolvedValue({ available: true }) };
    return {
      admin,
      telemetry,
      assist,
      c: new AdminSonioxController(
        admin as never,
        telemetry as never,
        assist as never,
      ),
    };
  };
  it('checks operator before reading either backend', async () => {
    const b = make();
    b.admin.assertOperator.mockRejectedValue(Error('forbidden'));
    await expect(b.c.report({ userId: 'u' } as never)).rejects.toThrow(
      'forbidden',
    );
    expect(b.telemetry.report).not.toHaveBeenCalled();
    expect(b.assist.call).not.toHaveBeenCalled();
  });
  it('retains generator statistics if sites is offline', async () => {
    const b = make();
    b.assist.call.mockRejectedValue(Error('offline'));
    const r = await b.c.report({ userId: 'op' } as never);
    expect(r.generator.available).toBe(true);
    expect(r.sites).toMatchObject({ available: false });
    expect(b.assist.call).toHaveBeenCalledWith('GET', '/soniox', 'op');
  });
});
