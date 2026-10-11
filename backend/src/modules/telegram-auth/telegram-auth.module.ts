import { Module } from '@nestjs/common';
import { TelegramIdentityMiddleware } from './telegram-identity.middleware';

/**
 * TelegramAuthModule
 *
 * Exports TelegramIdentityMiddleware so bootstrap can register it globally
 * on Express before routes are initialized.
 */
@Module({
  providers: [TelegramIdentityMiddleware],
  exports: [TelegramIdentityMiddleware],
})
export class TelegramAuthModule {}
