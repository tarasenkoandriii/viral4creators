/**
 * GeminiFilesService
 *
 * Wraps the Gemini Files API for uploaded (non-YouTube) reference videos.
 * This replaces the old inline-base64 approach (whole video re-encoded and
 * stuffed into the request body, capped at effectively ~20MB/request) with
 * the proper large-file path: upload once, wait for Google to finish
 * processing, then reference the file by URI in generateContent.
 *
 * Verified against @google/genai v1.30.0's own type definitions:
 *  - files.upload({ file: Blob | string, config: { mimeType } })
 *  - files.get({ name }) -> { state: 'PROCESSING' | 'ACTIVE' | 'FAILED', uri, mimeType }
 *  - files.delete({ name })
 */

import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI, FileState } from '@google/genai';
import { createGeminiClient } from '../../common/gemini-client';

const POLL_INTERVAL_MS = 3000;
// Reference ads are short (seconds to a couple of minutes), so processing
// should finish well within this window. Fail fast instead of tying up a
// Vercel Function invocation indefinitely (Hobby caps at 300s total anyway).
const POLL_TIMEOUT_MS = 120000; // 2 minutes

export interface GeminiUploadedFile {
  name: string;
  uri: string;
  mimeType: string;
}

@Injectable()
export class GeminiFilesService {
  private readonly logger = new Logger(GeminiFilesService.name);
  private readonly genai: GoogleGenAI;

  constructor() {
    // Ключ — явно в SDK (этап 53, В-6.15): `new GoogleGenAI({})` читал
    // только свои переменные, и GOOGLE_GEMINI_API_KEY до него не доходил.
    this.genai = createGeminiClient();
  }

  /**
   * Upload video bytes to the Gemini Files API and wait until Google has
   * finished processing them (state ACTIVE). Google auto-expires the file
   * after 48h regardless; call deleteFile() once you're done with it to
   * tidy up sooner.
   */
  async uploadAndWaitActive(
    buffer: Buffer,
    mimeType: string,
  ): Promise<GeminiUploadedFile> {
    // Buffer's ArrayBufferLike typing (possibly SharedArrayBuffer) doesn't
    // structurally satisfy BlobPart — an explicit Uint8Array view does.
    const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });

    const uploaded = await this.genai.files.upload({
      file: blob,
      config: { mimeType },
    });

    if (!uploaded.name) {
      throw new Error('Gemini did not return a file name for the upload');
    }

    let current = uploaded;
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (current.state === FileState.PROCESSING) {
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for Gemini to process the video');
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      current = await this.genai.files.get({ name: uploaded.name });
    }

    if (current.state === FileState.FAILED) {
      throw new Error(
        current.error?.message || 'Gemini failed to process the uploaded video',
      );
    }

    if (!current.uri) {
      throw new Error('Gemini did not return a URI for the processed file');
    }

    return {
      name: uploaded.name,
      uri: current.uri,
      mimeType: current.mimeType || mimeType,
    };
  }

  /** Best-effort cleanup — never let this fail the analysis that already succeeded. */
  async deleteFile(name: string): Promise<void> {
    await this.genai.files.delete({ name }).catch((error: unknown) => {
      this.logger.warn(`Failed to delete Gemini file ${name}: ${error}`);
    });
  }
}
