import { Module } from '@nestjs/common';
import { GrokVideoService } from '../generation/grok-video.service';
import { GreetingVoiceController } from './greeting-voice.controller';
import { GreetingVoiceService } from './greeting-voice.service';

/** Голос отправителя для озвучки поздравления (фича №34). */
@Module({
  controllers: [GreetingVoiceController],
  // `GrokVideoService` берётся напрямую, а не через `GenerationModule`:
  // нужен один читающий вызов (роестр голосов) плюс тот же клиент xAI,
  // а весь генерационный модуль сюда тянуть незачем — он сам тянет
  // кредиты, планы и постобработку.
  providers: [GreetingVoiceService, GrokVideoService],
  exports: [GreetingVoiceService],
})
export class GreetingVoiceModule {}
