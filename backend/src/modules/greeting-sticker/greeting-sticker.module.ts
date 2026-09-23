import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { GreetingStickerController } from './greeting-sticker.controller';
import { GreetingStickerService } from './greeting-sticker.service';

/** Наклейки поверх кадра (фича №8). */
@Module({
  imports: [StorageModule],
  controllers: [GreetingStickerController],
  providers: [GreetingStickerService],
  exports: [GreetingStickerService],
})
export class GreetingStickerModule {}
