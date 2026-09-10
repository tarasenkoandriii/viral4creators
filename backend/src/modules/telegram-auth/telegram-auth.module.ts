import { Module } from '@nestjs/common';
import { TelegramIdentityMiddleware } from './telegram-identity.middleware';

/**
 * TelegramAuthModule
 *
 * Exports TelegramIdentityMiddleware so AppModule can wire it up globally
 * via NestModule.configure() — see app.module.ts.
 */
@Module({
  providers: [TelegramIdentityMiddleware],
  exports: [TelegramIdentityMiddleware],
})
export class TelegramAuthModule {}
