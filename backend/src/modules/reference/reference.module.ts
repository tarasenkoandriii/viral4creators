import { Module } from '@nestjs/common';
import { ReferenceController } from './reference.controller';

/** Static reference data (countries → currency) — doc/PRODUCT-PROJECT-SPEC.md §6.3, Stage 6. */
@Module({ controllers: [ReferenceController] })
export class ReferenceModule {}
