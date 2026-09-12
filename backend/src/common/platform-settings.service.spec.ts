import { PlatformSettingsService } from './platform-settings.service';

function build() {
  const findUnique = jest.fn();
  const upsert = jest.fn();
  const prisma = { platformSetting: { findUnique, upsert } };
  const svc = new PlatformSettingsService(prisma as never);
  return { svc, findUnique, upsert };
}

describe('PlatformSettingsService', () => {
  it('ключ не задавался — null, без падения', async () => {
    const { svc, findUnique } = build();
    findUnique.mockResolvedValue(null);
    await expect(svc.get('k')).resolves.toBeNull();
    expect(findUnique).toHaveBeenCalledWith({ where: { key: 'k' } });
  });

  it('возвращает сохранённое значение', async () => {
    const { svc, findUnique } = build();
    findUnique.mockResolvedValue({ key: 'k', value: 'elevenlabs' });
    await expect(svc.get('k')).resolves.toBe('elevenlabs');
  });

  it('повторный get в пределах TTL не бьёт в базу второй раз', async () => {
    const { svc, findUnique } = build();
    findUnique.mockResolvedValue({ key: 'k', value: 'resemble' });
    await svc.get('k');
    await svc.get('k');
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('set пишет через upsert и сразу обновляет кеш (без похода в базу)', async () => {
    const { svc, findUnique, upsert } = build();
    await svc.set('k', 'veo', 'admin-1');
    expect(upsert).toHaveBeenCalledWith({
      where: { key: 'k' },
      create: { key: 'k', value: 'veo', updatedBy: 'admin-1' },
      update: { value: 'veo', updatedBy: 'admin-1' },
    });
    await expect(svc.get('k')).resolves.toBe('veo');
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('разные ключи кешируются независимо', async () => {
    const { svc, findUnique } = build();
    findUnique.mockImplementation(async ({ where: { key } }) => ({
      key,
      value: `v-${key}`,
    }));
    await expect(svc.get('a')).resolves.toBe('v-a');
    await expect(svc.get('b')).resolves.toBe('v-b');
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});
