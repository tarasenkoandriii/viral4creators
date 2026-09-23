import { Module } from '@nestjs/common';
import { GreetingScenesController } from './greeting-scenes.controller';
import { GreetingScenesService } from './greeting-scenes.service';

/** Число сцен мультисценового поздравления (фича №7). */
@Module({
  controllers: [GreetingScenesController],
  providers: [GreetingScenesService],
  exports: [GreetingScenesService],
})
export class GreetingScenesModule {}
