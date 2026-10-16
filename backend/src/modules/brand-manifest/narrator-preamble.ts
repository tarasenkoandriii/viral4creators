/** A recording approved by its owner. Never a global voice/provider setting. */
export interface NarratorPreamble {
  sourcePathname?: string;
  draftId?: string;
  version: 1;
  url: string;
  pathname: string;
  seconds: number;
  locale: string;
  approvedAt: string;
  manifestId: string;
  characterId: string | null;
  imageUrl: string | null;
  /** Selected brand profile at approval, not a claim about the voice in the recording. */
  voiceId: string | null;
  voiceProvider: string | null;
}

export function parseNarratorPreamble(raw: unknown): NarratorPreamble | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as NarratorPreamble;
  if (
    p.version !== 1 ||
    typeof p.manifestId !== 'string' ||
    typeof p.pathname !== 'string' ||
    !/^((brand-manifests\/[^/]+\/preambles\/[a-f0-9-]+)|(tutorial-video-frames\/[^/]+\/preamble-[a-f0-9-]+))\.mp4$/.test(
      p.pathname,
    ) ||
    !(p.draftId
      ? p.pathname.startsWith(`tutorial-video-frames/${p.draftId}/preamble-`)
      : p.pathname.startsWith(`brand-manifests/${p.manifestId}/preambles/`)) ||
    typeof p.approvedAt !== 'string' ||
    typeof p.url !== 'string' ||
    !Number.isFinite(p.seconds) ||
    p.seconds < 5 ||
    p.seconds > 10 ||
    !['ru', 'uk', 'en', 'de', 'es'].includes(p.locale) ||
    !Number.isFinite(Date.parse(p.approvedAt))
  )
    return null;
  try {
    const u = new URL(p.url);
    if (
      u.protocol !== 'https:' ||
      !u.hostname.endsWith('.public.blob.vercel-storage.com') ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      decodeURIComponent(u.pathname) !== `/${p.pathname}`
    )
      return null;
  } catch {
    return null;
  }
  return p;
}

/** Read bounded ISO-BMFF metadata, not client-supplied duration. Reject fragmented files.
 * Both audio and video tracks are mandatory: concat must never guess a missing stream. */
export function preambleMp4Seconds(buffer: Buffer): number | null {
  let duration: number | null = null;
  let audio = false;
  let video = false;
  let boxes = 0;
  const walk = (start: number, end: number, depth: number): boolean => {
    if (depth > 5) return false;
    for (let pos = start; pos < end; ) {
      if (++boxes > 10000 || pos + 8 > end) return false;
      let size = buffer.readUInt32BE(pos);
      const type = buffer.toString('ascii', pos + 4, pos + 8);
      let header = 8;
      if (size === 1) {
        if (pos + 16 > end) return false;
        const big = buffer.readBigUInt64BE(pos + 8);
        if (big > BigInt(buffer.length)) return false;
        size = Number(big);
        header = 16;
      } else if (size === 0) size = end - pos;
      if (
        size < header ||
        pos + size > end ||
        type === 'moof' ||
        type === 'mvex'
      )
        return false;
      const data = pos + header;
      if (
        ['moov', 'trak', 'mdia'].includes(type) &&
        !walk(data, pos + size, depth + 1)
      )
        return false;
      if (type === 'mvhd') {
        const v = buffer[data];
        const offset = v === 0 ? 12 : v === 1 ? 20 : -1;
        if (offset < 0 || data + offset + (v === 0 ? 8 : 12) > pos + size)
          return false;
        const scale = buffer.readUInt32BE(data + offset);
        const ticks =
          v === 0
            ? buffer.readUInt32BE(data + offset + 4)
            : Number(buffer.readBigUInt64BE(data + offset + 4));
        if (!scale || !Number.isSafeInteger(ticks)) return false;
        duration = ticks / scale;
      }
      if (type === 'hdlr') {
        if (data + 12 > pos + size) return false;
        const handler = buffer.toString('ascii', data + 8, data + 12);
        audio ||= handler === 'soun';
        video ||= handler === 'vide';
      }
      pos += size;
    }
    return true;
  };
  if (
    !walk(0, buffer.length, 0) ||
    !audio ||
    !video ||
    duration === null ||
    duration < 5 ||
    duration > 10
  )
    return null;
  return duration;
}
