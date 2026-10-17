import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  StoryDevelopmentGuard,
  StoryPublicDisabledGuard,
} from './story-development.guard';
describe('Story-Tales development access', () => {
  const original = process.env.STORY_TALES_OWNER_TELEGRAM_ID;
  const findFirst = jest.fn();
  const guard = new StoryDevelopmentGuard({
    user: { findFirst },
  } as unknown as PrismaService);
  const ctx = (id?: string) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ telegramUserId: id }) }),
    }) as ExecutionContext;
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.STORY_TALES_OWNER_TELEGRAM_ID = 'owner-telegram';
  });
  afterAll(() => {
    if (original === undefined)
      delete process.env.STORY_TALES_OWNER_TELEGRAM_ID;
    else process.env.STORY_TALES_OWNER_TELEGRAM_ID = original;
  });
  it('requires the authenticated identity to match the configured owner', async () => {
    findFirst.mockResolvedValue({ id: 'owner-db-id' });
    await expect(guard.canActivate(ctx('owner-db-id'))).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'owner-db-id', telegramId: 'owner-telegram' },
      select: { id: true },
    });
  });
  it('denies another authenticated account even if it has operator or Premium privileges', async () => {
    findFirst.mockResolvedValue(null);
    await expect(guard.canActivate(ctx('another-user'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it('fails closed when owner configuration is missing', async () => {
    delete process.env.STORY_TALES_OWNER_TELEGRAM_ID;
    await expect(guard.canActivate(ctx('owner-db-id'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst).not.toHaveBeenCalled();
  });
  it('fails closed for anonymous requests', async () => {
    await expect(guard.canActivate(ctx())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst).not.toHaveBeenCalled();
  });
  it('denies every public gift capability, including old media URLs', () => {
    expect(() => new StoryPublicDisabledGuard().canActivate()).toThrow(
      NotFoundException,
    );
  });
});
