import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { TutorialHelpController } from './tutorial-help.controller';
import { TutorialHelpService } from './tutorial-help.service';

/** Справка по теме мастера — текст всегда, вычитанный ролик если есть. */
@Module({
  imports: [PrismaModule],
  controllers: [TutorialHelpController],
  providers: [TutorialHelpService],
})
export class TutorialHelpModule {}
