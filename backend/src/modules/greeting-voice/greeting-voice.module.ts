import { Module } from '@nestjs/common';
import { GreetingVoiceController } from './greeting-voice.controller';
import { GreetingVoiceService } from './greeting-voice.service';

/** Голос отправителя для озвучки поздравления (фича №34). */
@Module({
  controllers: [GreetingVoiceController],
  providers: [GreetingVoiceService],
  exports: [GreetingVoiceService],
})
export class GreetingVoiceModule {}
