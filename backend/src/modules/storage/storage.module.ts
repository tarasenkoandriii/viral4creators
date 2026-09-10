/**
 * StorageModule
 *
 * Module providing storage services. Used to be BlobService (transit-only
 * reference video) + S3Service (durable product image / generated video)
 * — consolidated onto BlobService alone, see its doc comment for the full
 * rationale. S3Service is gone.
 */

import { Module } from '@nestjs/common';
import { BlobService } from './blob.service';

@Module({
  providers: [BlobService],
  exports: [BlobService],
})
export class StorageModule {}
