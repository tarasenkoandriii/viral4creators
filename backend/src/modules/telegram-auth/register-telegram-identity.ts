import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { TelegramIdentityMiddleware } from './telegram-identity.middleware';

/** Register the DI-managed identity provider on the underlying Express app.
 * No route-pattern/global-prefix translation is involved. */
export function registerTelegramIdentity(app: INestApplication): void {
  const identity = app.get(TelegramIdentityMiddleware);
  app.use((req: Request, res: Response, next: NextFunction) => {
    void identity.use(req, res, next).catch(next);
  });
}
