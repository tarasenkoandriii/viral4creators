import { Module } from '@nestjs/common';
import { TelegramLoginController } from './telegram-login.controller';
import { TelegramLoginService } from './telegram-login.service';

@Module({
  controllers: [TelegramLoginController],
  providers: [TelegramLoginService],
})
export class TelegramLoginModule {}
