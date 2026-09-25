jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiKeyService,
  MAX_ACTIVE_KEYS,
  normalizeKeyName,
  toView,
} from './api-key.service';
import { hashApiKey } from '../../common/api-key';

const NOW = new Date('2026-09-24T10:00:00Z');
const row = (over: Record<string, unknown> = {}) => ({
  id: 'k1',
  name: 'CI релизов',
  hint: 'v4c_abcd1234',
  createdAt: NOW,
  lastUsedAt: null,
  revokedAt: null,
  ...over,
});

function build(over: { active?: number; found?: unknown } = {}) {
  const created: Record<string, unknown>[] = [];
  const prisma = {
    apiKey: {
      findMany: jest.fn().mockResolvedValue([row()]),
      count: jest.fn().mockResolvedValue(over.active ?? 0),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return row(data);
      }),
      findFirst: jest
        .fn()
        .mockResolvedValue('found' in over ? over.found : row()),
      update: jest.fn(
        async ({ data }: { data: Record<string, unknown> }) =>
          row({ ...data }) as unknown,
      ),
    },
  };
  const plans = { assertUser: jest.fn().mockResolvedValue(undefined) };
  return {
    service: new ApiKeyService(prisma as never, plans as never),
    prisma,
    plans,
    created,
  };
}

describe('normalizeKeyName', () => {
  it('пустое имя получает подпись, а не остаётся пустым', () => {
    // Список из нескольких безымянных строк — это список, в котором
    // нельзя отозвать нужный ключ.
    expect(normalizeKeyName('  ')).toBe('Без названия');
    expect(normalizeKeyName(undefined)).toBe('Без названия');
    expect(normalizeKeyName(42)).toBe('Без названия');
  });

  it('длинное имя обрезается, а не отвергается', () => {
    expect(normalizeKeyName('я'.repeat(200))).toHaveLength(60);
  });
});

describe('toView', () => {
  it('секрета в представлении нет — только открытая часть', () => {
    const view = toView(row() as never);
    expect(view.hint).toBe('v4c_abcd1234');
    expect(JSON.stringify(view)).not.toContain('keyHash');
  });
});

describe('ApiKeyService.list', () => {
  it('потолок приходит вместе со списком, а не живёт копией на экране', async () => {
    // Копии таких чисел расходятся с оригиналом всегда в худшую
    // сторону: человеку показывают кнопку, которую сервер потом
    // запрещает (аудит этапа 145).
    const { service } = build();
    const result = await service.list('u1');
    expect(result.maxActive).toBe(MAX_ACTIVE_KEYS);
    expect(result.keys).toHaveLength(1);
  });
});

describe('ApiKeyService.issue', () => {
  it('секрет возвращается ОДИН раз, а в базу уходит только хеш', async () => {
    const { service, created } = build();

    const { secret } = await service.issue('u1', 'CI релизов');

    expect(created[0].keyHash).toBe(hashApiKey(secret));
    // Самого секрета в записи нет ни под каким именем.
    expect(JSON.stringify(created[0])).not.toContain(secret);
    // А открытая часть — это НАЧАЛО секрета, иначе она его не опознаёт.
    expect(secret.startsWith(String(created[0].hint))).toBe(true);
  });

  it('право проверяется на выдаче, а не только на входе', async () => {
    // Ключ, выданный тому, кто им не воспользуется, — лишний живой
    // секрет, и кончится он тем, что о нём забудут.
    const { service, plans } = build();
    await service.issue('u1', 'x');
    expect(plans.assertUser).toHaveBeenCalledWith('u1', 'externalApi');
  });

  it('потолок живых ключей не обходится', async () => {
    const { service } = build({ active: MAX_ACTIVE_KEYS });
    await expect(service.issue('u1', 'ещё один')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('потолок считает живые, а не все за историю', async () => {
    // Упереться в потолок из-за прошлогодних отзывов было бы странно.
    const { service, prisma } = build();
    await service.issue('u1', 'x');
    expect(prisma.apiKey.count).toHaveBeenCalledWith({
      where: { userId: 'u1', revokedAt: null },
    });
  });
});

describe('ApiKeyService.setWebhook (этап 146)', () => {
  it('адрес проверяется ЗДЕСЬ, а не при доставке', async () => {
    // По нему пойдёт наш сервер изнутри нашей же сети, и «проверим,
    // когда будем стучаться» значит держать негодный адрес в базе до
    // первого исхода — а ошибку человек увидит не там, где сделал.
    const { service, prisma } = build();
    await expect(
      service.setWebhook('u1', 'k1', 'http://169.254.169.254/'),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.apiKey.update).not.toHaveBeenCalled();
  });

  it('пустая строка снимает адрес, а не пишет пустоту', async () => {
    const { service, prisma } = build();
    await service.setWebhook('u1', 'k1', '  ');
    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { webhookUrl: null },
    });
  });

  it('чужой ключ по id не настраивается', async () => {
    const { service, prisma } = build();
    await service.setWebhook('u1', 'k1', 'https://hooks.example.com/x');
    expect(prisma.apiKey.findFirst).toHaveBeenCalledWith({
      where: { id: 'k1', userId: 'u1' },
    });
  });

  it('несуществующий ключ — 404', async () => {
    const { service } = build({ found: null });
    await expect(
      service.setWebhook('u1', 'k1', 'https://hooks.example.com/x'),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('ApiKeyService.revoke', () => {
  it('чужой ключ по id не отзывается', async () => {
    // Иначе владелец узнал бы об отзыве по молчанию своей интеграции.
    const { service, prisma } = build();
    await service.revoke('u1', 'k1');
    expect(prisma.apiKey.findFirst).toHaveBeenCalledWith({
      where: { id: 'k1', userId: 'u1' },
    });
  });

  it('несуществующий ключ — 404', async () => {
    const { service } = build({ found: null });
    await expect(service.revoke('u1', 'k1')).rejects.toThrow(NotFoundException);
  });

  it('повторный отзыв не переписывает дату', async () => {
    // Иначе «отозван тогда-то» превращалось бы в «отозван только что»
    // при каждом нажатии.
    const revokedAt = new Date('2026-09-20T10:00:00Z');
    const { service, prisma } = build({ found: row({ revokedAt }) });

    const view = await service.revoke('u1', 'k1');

    expect(prisma.apiKey.update).not.toHaveBeenCalled();
    expect(view.revokedAt).toBe(revokedAt.toISOString());
  });
});
