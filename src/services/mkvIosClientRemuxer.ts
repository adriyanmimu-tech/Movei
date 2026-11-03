/**
 * Pure Client-Side In-Browser Matroska (.mkv) to Apple MP4 (video/mp4) Remuxer Engine
 * Runs 100% inside iPhone / iPad Safari & mobile browsers with ZERO backend server dependency.
 * Works on static hosts (GitHub Pages mimu-tech.github.io) and Cloud Run alike.
 */

export interface MkvTrackInfo {
  number: number;
  type: number; // 1 = video, 2 = audio
  codecId: string;
  codecPrivate: Uint8Array | null;
  width: number;
  height: number;
  sampleRate: number;
  outSampleRate: number;
  channels: number;
  defaultDuration: number;
}

export interface VideoSample {
  ptsMs: number;
  data: Uint8Array;
  keyframe: boolean;
}

export interface AudioSample {
  ptsMs: number;
  data: Uint8Array;
}

export interface MkvSubtitleSample {
  ptsMs: number;
  endPtsMs: number;
  text: string;
  trackNum: number;
}

export interface RemuxedSegmentItem {
  index: number;
  blobUrl: string;
  startSec: number;
  durationSec: number;
}

function readVint(b: Uint8Array, pos: number): { val: number; len: number } | null {
  if (pos >= b.byteLength) return null;
  const b0 = b[pos];
  if (b0 === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && (b0 & mask) === 0) {
    len++;
    mask >>= 1;
  }
  if (len > 8 || pos + len > b.byteLength) return null;
  let val = b0 & (mask - 1);
  let allOnes = val === mask - 1;
  for (let i = 1; i < len; i++) {
    val = val * 256 + b[pos + i];
    if (b[pos + i] !== 0xff) allOnes = false;
  }
  return { val: allOnes ? -1 : val, len };
}

function readEbmlId(b: Uint8Array, pos: number): { id: number; len: number } | null {
  if (pos >= b.byteLength) return null;
  const b0 = b[pos];
  if (b0 === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (len <= 4 && (b0 & mask) === 0) {
    len++;
    mask >>= 1;
  }
  if (len > 4 || pos + len > b.byteLength) return null;
  let id = 0;
  for (let i = 0; i < len; i++) {
    id = id * 256 + b[pos + i];
  }
  return { id, len };
}

function readUint(b: Uint8Array, pos: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) {
    v = v * 256 + b[pos + i];
  }
  return v;
}

function readFloat(b: Uint8Array, pos: number, len: number): number {
  if (pos + len > b.byteLength) return 0;
  const dv = new DataView(b.buffer, b.byteOffset + pos, len);
  if (len === 4) return dv.getFloat32(0, false);
  if (len === 8) return dv.getFloat64(0, false);
  return 0;
}

function decodeAscii(b: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) {
    if (b[i] === 0) break;
    s += String.fromCharCode(b[i]);
  }
  return s;
}

function findClusterOffset(b: Uint8Array, fromPos: number): number {
  const limit = b.byteLength - 4;
  for (let i = Math.max(0, fromPos); i <= limit; i++) {
    if (
      b[i] === 0x1f &&
      b[i + 1] === 0x43 &&
      b[i + 2] === 0xb6 &&
      b[i + 3] === 0x75
    ) {
      return i;
    }
  }
  return -1;
}

export interface MkvCuePoint {
  timeMs: number;
  byteOffset: number;
}

export function parseMkvHeaderAndSamples(
  b: Uint8Array,
  existingTracks?: MkvTrackInfo[],
  existingTimecodeScale?: number
): {
  tracks: MkvTrackInfo[];
  timecodeScale: number;
  durationSec: number;
  segmentDataOffset: number;
  firstClusterOffset: number;
  cuesByteOffset: number;
  videoSamples: VideoSample[];
  audioSamples: AudioSample[];
  subtitleSamples: MkvSubtitleSample[];
  consumedBytes: number;
} {
  let pos = 0;
  let timecodeScale = existingTimecodeScale || 1_000_000;
  let rawDuration = 0;
  const tracks: MkvTrackInfo[] = existingTracks ? [...existingTracks] : [];
  const videoSamples: VideoSample[] = [];
  const audioSamples: AudioSample[] = [];
  const subtitleSamples: MkvSubtitleSample[] = [];
  let currentClusterTime = 0;
  let lastCompleteClusterEnd = 0;
  let segmentDataOffset = 52;
  let firstClusterOffset = -1;
  let cuesByteOffset = -1;

  const parseTracksElement = (start: number, end: number) => {
    if (tracks.length > 0) return;
    let p = start;
    while (p < end) {
      const idObj = readEbmlId(b, p);
      if (!idObj) break;
      const szObj = readVint(b, p + idObj.len);
      if (!szObj) break;
      const dStart = p + idObj.len + szObj.len;
      const dEnd = szObj.val < 0 ? end : Math.min(end, dStart + szObj.val);
      if (idObj.id === 0xae) {
        const track: MkvTrackInfo = {
          number: 0,
          type: 0,
          codecId: '',
          codecPrivate: null,
          width: 1280,
          height: 720,
          sampleRate: 44100,
          outSampleRate: 0,
          channels: 2,
          defaultDuration: 0,
        };
        let tp = dStart;
        while (tp < dEnd) {
          const tid = readEbmlId(b, tp);
          if (!tid) break;
          const tsz = readVint(b, tp + tid.len);
          if (!tsz) break;
          const tds = tp + tid.len + tsz.len;
          const tde = tsz.val < 0 ? dEnd : Math.min(dEnd, tds + tsz.val);
          if (tid.id === 0xd7) track.number = readUint(b, tds, tsz.val);
          else if (tid.id === 0x83) track.type = readUint(b, tds, tsz.val);
          else if (tid.id === 0x86) track.codecId = decodeAscii(b, tds, tde);
          else if (tid.id === 0x63a2) track.codecPrivate = b.slice(tds, tde);
          else if (tid.id === 0x23e383) track.defaultDuration = readUint(b, tds, tsz.val);
          else if (tid.id === 0xe0) {
            let vp = tds;
            while (vp < tde) {
              const vid = readEbmlId(b, vp);
              if (!vid) break;
              const vsz = readVint(b, vp + vid.len);
              if (!vsz) break;
              const vds = vp + vid.len + vsz.len;
              if (vid.id === 0xb0) track.width = readUint(b, vds, vsz.val);
              else if (vid.id === 0xba) track.height = readUint(b, vds, vsz.val);
              vp = vds + vsz.val;
            }
          } else if (tid.id === 0xe1) {
            let ap = tds;
            while (ap < tde) {
              const aid = readEbmlId(b, ap);
              if (!aid) break;
              const asz = readVint(b, ap + aid.len);
              if (!asz) break;
              const ads = ap + aid.len + asz.len;
              if (aid.id === 0xb5) track.sampleRate = readFloat(b, ads, asz.val);
              else if (aid.id === 0x78b5) track.outSampleRate = readFloat(b, ads, asz.val);
              else if (aid.id === 0x9f) track.channels = readUint(b, ads, asz.val);
              ap = ads + asz.val;
            }
          }
          tp = tde;
        }
        tracks.push(track);
      }
      p = dEnd;
    }
  };

  const handleBlock = (
    dStart: number,
    dEnd: number,
    isKeyframeHint: boolean,
    blockDurationTicks = 0
  ) => {
    const trkVint = readVint(b, dStart);
    if (!trkVint) return;
    const trackNum = trkVint.val;
    let bp = dStart + trkVint.len;
    if (bp + 3 > dEnd) return;
    let relTime = (b[bp] << 8) | b[bp + 1];
    if (relTime & 0x8000) relTime -= 0x10000;
    const flags = b[bp + 2];
    bp += 3;
    const scaleMs = timecodeScale / 1_000_000;
    const absTimeMs = (currentClusterTime + relTime) * scaleMs;
    const isKeyframe = isKeyframeHint || Boolean(flags & 0x80);
    const lacing = (flags >> 1) & 0x03;
    const frames: Uint8Array[] = [];

    if (lacing === 0) {
      if (bp < dEnd) frames.push(b.subarray(bp, dEnd));
    } else if (bp < dEnd) {
      const numFrames = b[bp] + 1;
      bp += 1;
      const sizes: number[] = [];
      if (lacing === 1) {
        let sum = 0;
        for (let i = 0; i < numFrames - 1; i++) {
          let s = 0;
          while (bp < dEnd && b[bp] === 255) {
            s += 255;
            bp++;
          }
          if (bp < dEnd) {
            s += b[bp];
            bp++;
          }
          sizes.push(s);
          sum += s;
        }
        sizes.push(dEnd - bp - sum);
      } else if (lacing === 2) {
        const fsz = Math.floor((dEnd - bp) / numFrames);
        for (let i = 0; i < numFrames; i++) sizes.push(fsz);
      } else if (lacing === 3) {
        const first = readVint(b, bp);
        if (!first) return;
        bp += first.len;
        let prev = first.val;
        sizes.push(prev);
        let sum = prev;
        for (let i = 1; i < numFrames - 1; i++) {
          const dv = readVint(b, bp);
          if (!dv) return;
          bp += dv.len;
          const bias = (1 << (7 * dv.len - 1)) - 1;
          prev = prev + (dv.val - bias);
          sizes.push(prev);
          sum += prev;
        }
        sizes.push(dEnd - bp - sum);
      }
      for (const sz of sizes) {
        if (sz > 0 && bp + sz <= dEnd) {
          frames.push(b.subarray(bp, bp + sz));
          bp += sz;
        }
      }
    }

    const vTrack = tracks.find((t) => t.type === 1);
    const aTrack =
      tracks.find((t) => t.type === 2 && /AAC/i.test(t.codecId)) ||
      tracks.find((t) => t.type === 2);
    const sTrack = tracks.find((t) => t.type === 17 && t.number === trackNum);
    if (vTrack && trackNum === vTrack.number) {
      const frameDurMs = vTrack.defaultDuration
        ? vTrack.defaultDuration / 1_000_000
        : 33.333;
      for (let i = 0; i < frames.length; i++) {
        videoSamples.push({
          ptsMs: absTimeMs + i * frameDurMs,
          data: frames[i],
          keyframe: isKeyframe && i === 0,
        });
      }
    } else if (aTrack && trackNum === aTrack.number) {
      const sr = aTrack.sampleRate || 44100;
      const frameDurMs = (1024 / sr) * 1000;
      for (let i = 0; i < frames.length; i++) {
        audioSamples.push({
          ptsMs: absTimeMs + i * frameDurMs,
          data: frames[i],
        });
      }
    } else if (sTrack && frames.length > 0) {
      try {
        const rawStr = new TextDecoder('utf-8').decode(frames[0]);
        let cleanText = rawStr;
        if (/ASS|SSA/i.test(sTrack.codecId)) {
          // Format: ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
          const parts = rawStr.split(',');
          if (parts.length >= 9) {
            cleanText = parts.slice(8).join(',');
          }
        }
        cleanText = cleanText
          .replace(/\{\\[^}]*\}/g, '')
          .replace(/\\N|\\n/g, ' ')
          .replace(/<[^>]+>/g, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
        if (cleanText.length >= 2) {
          const durMs =
            blockDurationTicks > 0 ? blockDurationTicks * scaleMs : 3500;
          subtitleSamples.push({
            ptsMs: Math.max(0, absTimeMs),
            endPtsMs: Math.max(0, absTimeMs) + Math.min(8000, Math.max(1200, durMs)),
            text: cleanText,
            trackNum,
          });
        }
      } catch {
        // ignore malformed subtitle block
      }
    }
  };

  // If this is a mid-file chunk that doesn't start at EBML header (0x1A45DFA3), jump to first Cluster (0x1F43B675)
  if (
    b.byteLength >= 4 &&
    !(b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) &&
    !(b[0] === 0x1f && b[1] === 0x43 && b[2] === 0xb6 && b[3] === 0x75)
  ) {
    const firstCluster = findClusterOffset(b, 0);
    if (firstCluster !== -1) {
      pos = firstCluster;
    }
  }

  while (pos < b.byteLength) {
    const idObj = readEbmlId(b, pos);
    if (!idObj) break;
    const szObj = readVint(b, pos + idObj.len);
    if (!szObj) break;
    const dStart = pos + idObj.len + szObj.len;
    const isUnknownSize = szObj.val < 0;
    const rawEnd = isUnknownSize ? b.byteLength : dStart + szObj.val;

    if (idObj.id === 0x18538067) {
      // Segment container: record exact Segment payload offset and step inside
      segmentDataOffset = dStart;
      pos = dStart;
      continue;
    }

    if (idObj.id === 0x114d9b74) {
      // SeekHead: parse Seek (0x4DBB) entries to locate exact Cues (0x1C53BB6B) byte offset!
      const dEnd = Math.min(b.byteLength, rawEnd);
      let sp = dStart;
      while (sp < dEnd) {
        const sid = readEbmlId(b, sp);
        if (!sid) break;
        const ssz = readVint(b, sp + sid.len);
        if (!ssz) break;
        const sds = sp + sid.len + ssz.len;
        const sde = ssz.val < 0 ? dEnd : Math.min(dEnd, sds + ssz.val);
        if (sid.id === 0x4dbb) {
          let kp = sds;
          let seekIdVal = 0;
          let seekPosVal = -1;
          while (kp < sde) {
            const kid = readEbmlId(b, kp);
            if (!kid) break;
            const ksz = readVint(b, kp + kid.len);
            if (!ksz) break;
            const kds = kp + kid.len + ksz.len;
            const kde = ksz.val < 0 ? sde : Math.min(sde, kds + ksz.val);
            if (kid.id === 0x53ab) seekIdVal = readUint(b, kds, ksz.val);
            else if (kid.id === 0x53ac) seekPosVal = readUint(b, kds, ksz.val);
            kp = kde;
          }
          if (seekIdVal === 0x1c53bb6b && seekPosVal >= 0) {
            cuesByteOffset = segmentDataOffset + seekPosVal;
          }
        }
        sp = sde;
      }
      pos = dEnd;
      continue;
    }

    if (idObj.id === 0x1549a966) {
      // Segment Info
      const dEnd = Math.min(b.byteLength, rawEnd);
      let ip = dStart;
      while (ip < dEnd) {
        const iid = readEbmlId(b, ip);
        if (!iid) break;
        const isz = readVint(b, ip + iid.len);
        if (!isz) break;
        const ids = ip + iid.len + isz.len;
        if (iid.id === 0x2ad7b1) timecodeScale = readUint(b, ids, isz.val);
        else if (iid.id === 0x4489) rawDuration = readFloat(b, ids, isz.val);
        ip = ids + isz.val;
      }
      pos = dEnd;
      continue;
    }

    if (idObj.id === 0x1654ae6b) {
      // Tracks
      const dEnd = Math.min(b.byteLength, rawEnd);
      parseTracksElement(dStart, dEnd);
      pos = dEnd;
      continue;
    }

    if (idObj.id === 0x1f43b675) {
      // Cluster
      if (firstClusterOffset < 0) {
        firstClusterOffset = pos;
      }
      // If this cluster overflows our downloaded buffer and we already parsed at least 1 complete cluster,
      // stop right at `pos` so the next HTTP Range fetch starts cleanly at this exact Cluster!
      if (!isUnknownSize && rawEnd > b.byteLength && lastCompleteClusterEnd > 0) {
        break;
      }

      const dEnd = Math.min(b.byteLength, rawEnd);
      let cp = dStart;
      while (cp < dEnd) {
        const cid = readEbmlId(b, cp);
        if (!cid) break;
        const csz = readVint(b, cp + cid.len);
        if (!csz) break;
        const cds = cp + cid.len + csz.len;
        const cRawEnd = csz.val < 0 ? dEnd : cds + csz.val;
        if (cRawEnd > b.byteLength) {
          cp = b.byteLength;
          break;
        }
        if (cid.id === 0xe7) {
          currentClusterTime = readUint(b, cds, csz.val);
        } else if (cid.id === 0xa3) {
          handleBlock(cds, cRawEnd, false, 0);
        } else if (cid.id === 0xa0) {
          let bgp = cds;
          let blockStart = -1;
          let blockEnd = -1;
          let hasReference = false;
          let blockDurTicks = 0;
          while (bgp < cRawEnd) {
            const bid = readEbmlId(b, bgp);
            if (!bid) break;
            const bsz = readVint(b, bgp + bid.len);
            if (!bsz) break;
            const bds = bgp + bid.len + bsz.len;
            const bde = Math.min(cRawEnd, bds + bsz.val);
            if (bid.id === 0xa1) {
              blockStart = bds;
              blockEnd = bde;
            } else if (bid.id === 0x9b) {
              blockDurTicks = readUint(b, bds, bsz.val);
            } else if (bid.id === 0xfb) {
              hasReference = true;
            }
            bgp = bde;
          }
          if (blockStart !== -1 && blockEnd !== -1) {
            handleBlock(blockStart, blockEnd, !hasReference, blockDurTicks);
          }
        }
        cp = cRawEnd;
      }

      lastCompleteClusterEnd = dEnd;
      pos = dEnd;
      continue;
    }

    if (rawEnd > b.byteLength) break;
    pos = rawEnd;
  }

  const durationSec =
    rawDuration > 0 ? (rawDuration * (timecodeScale / 1_000_000)) / 1000 : 0;

  return {
    tracks,
    timecodeScale,
    durationSec,
    segmentDataOffset,
    firstClusterOffset,
    cuesByteOffset,
    videoSamples,
    audioSamples,
    subtitleSamples,
    consumedBytes: lastCompleteClusterEnd > 0 ? lastCompleteClusterEnd : b.byteLength,
  };
}

/**
 * Parses the Matroska Cues (0x1C53BB6B) seek index table from the tail of the file.
 * Gives exact keyframe timestamps (ms) -> exact Cluster byte offsets for 0.1s instant seeking!
 */
export function parseMkvCuesFromBuffer(
  b: Uint8Array,
  segmentDataOffset = 52,
  timecodeScale = 1_000_000
): MkvCuePoint[] {
  let cuesPos = -1;
  const limit = b.byteLength - 4;
  for (let i = 0; i <= limit; i++) {
    if (
      b[i] === 0x1c &&
      b[i + 1] === 0x53 &&
      b[i + 2] === 0xbb &&
      b[i + 3] === 0x6b
    ) {
      cuesPos = i;
      break;
    }
  }
  if (cuesPos === -1) return [];

  const szObj = readVint(b, cuesPos + 4);
  if (!szObj) return [];
  let p = cuesPos + 4 + szObj.len;
  const end = szObj.val < 0 ? b.byteLength : Math.min(b.byteLength, p + szObj.val);
  const scaleMs = timecodeScale / 1_000_000;
  const cuePoints: MkvCuePoint[] = [];
  let lastOffset = -1;

  while (p < end) {
    const idObj = readEbmlId(b, p);
    if (!idObj) break;
    const sObj = readVint(b, p + idObj.len);
    if (!sObj) break;
    const ds = p + idObj.len + sObj.len;
    const de = sObj.val < 0 ? end : Math.min(end, ds + sObj.val);

    if (idObj.id === 0xbb) {
      // CuePoint
      let cp = ds;
      let rawCueTime = -1;
      let cueClusterPos = -1;
      while (cp < de) {
        const cid = readEbmlId(b, cp);
        if (!cid) break;
        const cs = readVint(b, cp + cid.len);
        if (!cs) break;
        const cds = cp + cid.len + cs.len;
        const cde = cs.val < 0 ? de : Math.min(de, cds + cs.val);
        if (cid.id === 0xb3) {
          rawCueTime = readUint(b, cds, cs.val);
        } else if (cid.id === 0xb7) {
          // CueTrackPositions
          let tp = cds;
          while (tp < cde) {
            const tid = readEbmlId(b, tp);
            if (!tid) break;
            const ts = readVint(b, tp + tid.len);
            if (!ts) break;
            const tds = tp + tid.len + ts.len;
            const tde = ts.val < 0 ? cde : Math.min(cde, tds + ts.val);
            if (tid.id === 0xf1 && cueClusterPos < 0) {
              cueClusterPos = readUint(b, tds, ts.val);
            }
            tp = tde;
          }
        }
        cp = cde;
      }
      if (rawCueTime >= 0 && cueClusterPos >= 0) {
        const byteOffset = segmentDataOffset + cueClusterPos;
        if (byteOffset !== lastOffset) {
          lastOffset = byteOffset;
          cuePoints.push({
            timeMs: rawCueTime * scaleMs,
            byteOffset,
          });
        }
      }
    }
    p = de;
  }

  return cuePoints.sort((a, b) => a.timeMs - b.timeMs);
}

function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  let size = 8;
  for (const p of payloads) size += p.byteLength;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, size, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let offset = 8;
  for (const p of payloads) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, false);
  return b;
}

function u16(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v & 0xffff, false);
  return b;
}

function strBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Builds a faststart ISO BMFF MP4 (ftyp + moov + mdat) from parsed H.264 & AAC samples.
 */
export function buildFastStartMp4(
  tracks: MkvTrackInfo[],
  rawVideoSamples: VideoSample[],
  rawAudioSamples: AudioSample[]
): { mp4Bytes: Uint8Array; durationSec: number; startSec: number } | null {
  const vTrack = tracks.find((t) => t.type === 1);
  if (!vTrack || !vTrack.codecPrivate || rawVideoSamples.length < 2) {
    return null;
  }
  const aTrack =
    tracks.find((t) => t.type === 2 && /AAC/i.test(t.codecId)) ||
    tracks.find((t) => t.type === 2);
  const isAacCompatible = !aTrack?.codecId || /AAC/i.test(aTrack.codecId);

  const basePtsMs = rawVideoSamples[0].ptsMs;
  const vSamples = rawVideoSamples.map((s) => ({
    ptsTicks: Math.max(0, Math.round((s.ptsMs - basePtsMs) * 90)),
    data: s.data,
    keyframe: s.keyframe,
  }));

  const aSampleRate = aTrack ? aTrack.sampleRate || 22050 : 44100;
  const aSamples = aTrack
    ? rawAudioSamples
        .filter((s) => s.ptsMs >= basePtsMs - 40)
        .map((s) => ({
          ptsMs: Math.max(0, s.ptsMs - basePtsMs),
          data: s.data,
        }))
    : [];

  // Ensure every video sample has a strictly unique PTS in presentation order
  // (prevents duplicate PTS/DTS errors in Apple CoreMedia & FFmpeg when Matroska blocks share rounded ms timestamps)
  const presOrder = vSamples
    .map((_, idx) => idx)
    .sort((a, b) => vSamples[a].ptsTicks - vSamples[b].ptsTicks || a - b);
  for (let i = 1; i < presOrder.length; i++) {
    const prevPts = vSamples[presOrder[i - 1]].ptsTicks;
    if (vSamples[presOrder[i]].ptsTicks <= prevPts) {
      vSamples[presOrder[i]].ptsTicks = prevPts + 90;
    }
  }

  // Calculate strictly monotonic DTS & non-negative Composition Time Offsets (CTO) for B-frames
  const dtsTicks: number[] = new Array(vSamples.length);
  for (let i = 0; i < vSamples.length; i++) {
    dtsTicks[i] = vSamples[presOrder[i]].ptsTicks;
  }
  const vDeltas: number[] = [];
  const vCtos: number[] = [];
  let minDiff = 0;
  for (let i = 0; i < vSamples.length; i++) {
    const diff = vSamples[i].ptsTicks - dtsTicks[i];
    if (diff < minDiff) minDiff = diff;
  }
  for (let i = 0; i < vSamples.length; i++) {
    const nextDts =
      i + 1 < vSamples.length ? dtsTicks[i + 1] : dtsTicks[i] + 3000;
    vDeltas.push(Math.max(90, nextDts - dtsTicks[i]));
    vCtos.push(vSamples[i].ptsTicks - dtsTicks[i] - minDiff);
  }

  let vDataLen = 0;
  for (const s of vSamples) vDataLen += s.data.byteLength;
  let aDataLen = 0;
  for (const s of aSamples) aDataLen += s.data.byteLength;

  const totalDur90k = vDeltas.reduce((acc, d) => acc + d, 0);
  const totalDurMs = Math.max(1, Math.round(totalDur90k / 90));

  const ftyp = box(
    'ftyp',
    strBytes('isom'),
    u32(512),
    strBytes('isomiso2avc1mp41')
  );

  const buildMoovWithOffsets = (vChunkOffset: number, aChunkOffset: number) => {
    const matrix = new Uint8Array([
      0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0,
    ]);

    const tkhdV = box(
      'tkhd',
      new Uint8Array([0, 0, 0, 3]),
      u32(0),
      u32(0),
      u32(1),
      u32(0),
      u32(totalDurMs),
      new Uint8Array(8),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      matrix,
      u32((vTrack.width || 1280) << 16),
      u32((vTrack.height || 720) << 16)
    );

    const mdhdV = box(
      'mdhd',
      u32(0),
      u32(0),
      u32(0),
      u32(90000),
      u32(totalDur90k),
      u16(0x55c4),
      u16(0)
    );
    const hdlrV = box(
      'hdlr',
      u32(0),
      u32(0),
      strBytes('vide'),
      new Uint8Array(12),
      strBytes('VideoHandler\0')
    );
    const vmhd = box('vmhd', new Uint8Array([0, 0, 0, 1]), new Uint8Array(8));
    const dref = box(
      'dref',
      u32(0),
      u32(1),
      box('url ', new Uint8Array([0, 0, 0, 1]))
    );
    const dinf = box('dinf', dref);

    const isHevc = /HEVC/i.test(vTrack.codecId);
    const isAv1 = /AV1/i.test(vTrack.codecId);
    const sampleEntryFourCC = isHevc ? 'hvc1' : isAv1 ? 'av01' : 'avc1';
    const configFourCC = isHevc ? 'hvcC' : isAv1 ? 'av1C' : 'avcC';

    const codecConfigBox = box(configFourCC, vTrack.codecPrivate!);
    const visualSampleEntry = box(
      sampleEntryFourCC,
      new Uint8Array(6),
      u16(1),
      new Uint8Array(16),
      u16(vTrack.width || 1280),
      u16(vTrack.height || 720),
      u32(0x00480000),
      u32(0x00480000),
      u32(0),
      u16(1),
      new Uint8Array(32),
      u16(0x0018),
      u16(0xffff),
      codecConfigBox
    );
    const stsdV = box('stsd', u32(0), u32(1), visualSampleEntry);

    const sttsVBuf = new Uint8Array(8 + vDeltas.length * 8);
    const sttsVDv = new DataView(sttsVBuf.buffer);
    sttsVDv.setUint32(4, vDeltas.length, false);
    for (let i = 0; i < vDeltas.length; i++) {
      sttsVDv.setUint32(8 + i * 8, 1, false);
      sttsVDv.setUint32(12 + i * 8, vDeltas[i], false);
    }
    const sttsV = box('stts', sttsVBuf);

    const cttsVBuf = new Uint8Array(8 + vCtos.length * 8);
    const cttsVDv = new DataView(cttsVBuf.buffer);
    cttsVDv.setUint32(4, vCtos.length, false);
    for (let i = 0; i < vCtos.length; i++) {
      cttsVDv.setUint32(8 + i * 8, 1, false);
      cttsVDv.setUint32(12 + i * 8, vCtos[i], false);
    }
    const cttsV = box('ctts', cttsVBuf);

    const syncIndices: number[] = [];
    for (let i = 0; i < vSamples.length; i++) {
      if (vSamples[i].keyframe) syncIndices.push(i + 1);
    }
    if (syncIndices.length === 0) syncIndices.push(1);
    const stssVBuf = new Uint8Array(8 + syncIndices.length * 4);
    const stssVDv = new DataView(stssVBuf.buffer);
    stssVDv.setUint32(4, syncIndices.length, false);
    for (let i = 0; i < syncIndices.length; i++) {
      stssVDv.setUint32(8 + i * 4, syncIndices[i], false);
    }
    const stssV = box('stss', stssVBuf);

    const stscV = box(
      'stsc',
      u32(0),
      u32(1),
      u32(1),
      u32(vSamples.length),
      u32(1)
    );
    const stszVBuf = new Uint8Array(12 + vSamples.length * 4);
    const stszVDv = new DataView(stszVBuf.buffer);
    stszVDv.setUint32(8, vSamples.length, false);
    for (let i = 0; i < vSamples.length; i++) {
      stszVDv.setUint32(12 + i * 4, vSamples[i].data.byteLength, false);
    }
    const stszV = box('stsz', stszVBuf);
    const stcoV = box('stco', u32(0), u32(1), u32(vChunkOffset));

    const stblV = box('stbl', stsdV, sttsV, cttsV, stssV, stscV, stszV, stcoV);
    const minfV = box('minf', vmhd, dinf, stblV);
    const mdiaV = box('mdia', mdhdV, hdlrV, minfV);
    const trakV = box('trak', tkhdV, mdiaV);

    const traks: Uint8Array[] = [trakV];

    if (aTrack && isAacCompatible && aSamples.length > 0) {
      const aDurTicks = aSamples.length * 1024;
      const tkhdA = box(
        'tkhd',
        new Uint8Array([0, 0, 0, 3]),
        u32(0),
        u32(0),
        u32(2),
        u32(0),
        u32(totalDurMs),
        new Uint8Array(8),
        u16(0),
        u16(0),
        u16(0x0100),
        u16(0),
        matrix,
        u32(0),
        u32(0)
      );
      const mdhdA = box(
        'mdhd',
        u32(0),
        u32(0),
        u32(0),
        u32(aSampleRate),
        u32(aDurTicks),
        u16(0x55c4),
        u16(0)
      );
      const hdlrA = box(
        'hdlr',
        u32(0),
        u32(0),
        strBytes('soun'),
        new Uint8Array(12),
        strBytes('SoundHandler\0')
      );
      const smhd = box('smhd', u32(0), u32(0));

      const asc = aTrack.codecPrivate || new Uint8Array([0x12, 0x10]);
      const esdsPayload = new Uint8Array([
        0,
        0,
        0,
        0,
        0x03,
        23 + asc.byteLength,
        0x00,
        0x02,
        0x00,
        0x04,
        15 + asc.byteLength,
        0x40,
        0x15,
        0x00,
        0x00,
        0x00,
        0x00,
        0x01,
        0xf4,
        0x00,
        0x00,
        0x01,
        0xf4,
        0x00,
        0x05,
        asc.byteLength,
        ...Array.from(asc),
        0x06,
        0x01,
        0x02,
      ]);
      const esds = box('esds', esdsPayload);
      const mp4a = box(
        'mp4a',
        new Uint8Array(6),
        u16(1),
        new Uint8Array(8),
        u16(aTrack.channels || 2),
        u16(16),
        u16(0),
        u16(0),
        u32(aSampleRate << 16),
        esds
      );
      const stsdA = box('stsd', u32(0), u32(1), mp4a);
      const sttsA = box(
        'stts',
        u32(0),
        u32(1),
        u32(aSamples.length),
        u32(1024)
      );
      const stscA = box(
        'stsc',
        u32(0),
        u32(1),
        u32(1),
        u32(aSamples.length),
        u32(1)
      );
      const stszABuf = new Uint8Array(12 + aSamples.length * 4);
      const stszADv = new DataView(stszABuf.buffer);
      stszADv.setUint32(8, aSamples.length, false);
      for (let i = 0; i < aSamples.length; i++) {
        stszADv.setUint32(12 + i * 4, aSamples[i].data.byteLength, false);
      }
      const stszA = box('stsz', stszABuf);
      const stcoA = box('stco', u32(0), u32(1), u32(aChunkOffset));
      const stblA = box('stbl', stsdA, sttsA, stscA, stszA, stcoA);
      const minfA = box('minf', smhd, dinf, stblA);
      const mdiaA = box('mdia', mdhdA, hdlrA, minfA);
      const trakA = box('trak', tkhdA, mdiaA);
      traks.push(trakA);
    }

    const mvhd = box(
      'mvhd',
      u32(0),
      u32(0),
      u32(0),
      u32(1000),
      u32(totalDurMs),
      u32(0x00010000),
      u16(0x0100),
      new Uint8Array(10),
      matrix,
      new Uint8Array(24),
      u32(traks.length + 1)
    );

    return box('moov', mvhd, ...traks);
  };

  // First pass to measure exact moov size for faststart (ftyp + moov + mdat)
  const dummyMoov = buildMoovWithOffsets(0, 0);
  const vChunkOffset = ftyp.byteLength + dummyMoov.byteLength + 8;
  const aChunkOffset = vChunkOffset + vDataLen;
  const moov = buildMoovWithOffsets(vChunkOffset, aChunkOffset);

  const mdatSize = 8 + vDataLen + aDataLen;
  const finalMp4 = new Uint8Array(
    ftyp.byteLength + moov.byteLength + mdatSize
  );
  finalMp4.set(ftyp, 0);
  finalMp4.set(moov, ftyp.byteLength);

  const mdatOffset = ftyp.byteLength + moov.byteLength;
  new DataView(finalMp4.buffer).setUint32(mdatOffset, mdatSize, false);
  finalMp4.set(strBytes('mdat'), mdatOffset + 4);

  let writePos = mdatOffset + 8;
  for (const s of vSamples) {
    finalMp4.set(s.data, writePos);
    writePos += s.data.byteLength;
  }
  for (const s of aSamples) {
    finalMp4.set(s.data, writePos);
    writePos += s.data.byteLength;
  }

  return {
    mp4Bytes: finalMp4,
    durationSec: totalDurMs / 1000,
    startSec: basePtsMs / 1000,
  };
}

/**
 * Global In-Memory Cache for Matroska Headers & Exact Keyframe Cues Tables.
 * Pre-warmed on card hover/touchstart so clicking Play jumps directly to the exact keyframe in 0ms!
 */
export interface CachedMkvStreamMeta {
  tracks: MkvTrackInfo[];
  timecodeScale: number;
  totalDurationSec: number;
  totalFileBytes: number;
  segmentDataOffset: number;
  firstClusterOffset: number;
  cuesByteOffset: number;
  cuePoints: MkvCuePoint[];
  initialSeg0Mp4?: {
    mp4Bytes: Uint8Array;
    startSec: number;
    durationSec: number;
    maxPtsMs: number;
    nextByteOffset: number;
    carryVideo: VideoSample[];
    carryAudio: AudioSample[];
    subtitles: MkvSubtitleSample[];
  };
}

const mkvStreamMetaCache = new Map<string, CachedMkvStreamMeta>();
const inFlightMetaPrewarms = new Map<string, Promise<CachedMkvStreamMeta | null>>();

export function prewarmMkvStreamMeta(url: string): Promise<CachedMkvStreamMeta | null> {
  if (!url || !url.startsWith('http') || /\.(mp4|m4v|m3u8)(\?|$)/i.test(url)) {
    return Promise.resolve(null);
  }
  const existing = mkvStreamMetaCache.get(url);
  if (
    existing &&
    existing.tracks.length > 0 &&
    existing.cuePoints.length > 0 &&
    existing.initialSeg0Mp4
  ) {
    return Promise.resolve(existing);
  }
  const inFlight = inFlightMetaPrewarms.get(url);
  if (inFlight) return inFlight;

  const p = (async (): Promise<CachedMkvStreamMeta | null> => {
    try {
      // 1. Fetch 420 KB opening burst (Matroska EBML + Tracks + Cluster #0) so Segment 0 is pre-built in RAM!
      const OPENING_BURST_BYTES = 420 * 1024;
      const res = await fetch(url, {
        headers: { Range: `bytes=0-${OPENING_BURST_BYTES - 1}` },
      });
      if (!res.ok && res.status !== 206) return null;

      let totalFileBytes = 0;
      const contentRange = res.headers.get('content-range') || '';
      const totalMatch = contentRange.match(/\/(\d+)/);
      if (totalMatch) {
        totalFileBytes = Number(totalMatch[1]);
      }

      const buf = new Uint8Array(await res.arrayBuffer());
      const parsed = parseMkvHeaderAndSamples(buf);
      if (parsed.tracks.length === 0) return null;

      let initialSeg0Mp4: CachedMkvStreamMeta['initialSeg0Mp4'] = undefined;
      if (parsed.videoSamples.length >= 2) {
        let vForSeg = parsed.videoSamples;
        let aForSeg = parsed.audioSamples;
        let carryVideo: VideoSample[] = [];
        let carryAudio: AudioSample[] = [];
        const endedAtCompleteCluster =
          parsed.consumedBytes > 0 && parsed.consumedBytes < buf.byteLength;
        if (!endedAtCompleteCluster) {
          let lastKf = -1;
          for (
            let i = vForSeg.length - 1;
            i >= Math.min(20, Math.floor(vForSeg.length * 0.65));
            i--
          ) {
            if (vForSeg[i].keyframe) {
              lastKf = i;
              break;
            }
          }
          if (lastKf > 12 && lastKf < vForSeg.length - 1) {
            const splitPts = vForSeg[lastKf].ptsMs;
            carryVideo = vForSeg.slice(lastKf);
            vForSeg = vForSeg.slice(0, lastKf);
            carryAudio = aForSeg.filter((a) => a.ptsMs >= splitPts);
            aForSeg = aForSeg.filter((a) => a.ptsMs < splitPts);
          }
        }
        const built = buildFastStartMp4(parsed.tracks, vForSeg, aForSeg);
        if (built) {
          let maxPtsMs = 0;
          for (const s of vForSeg) {
            if (s.ptsMs > maxPtsMs) maxPtsMs = s.ptsMs;
          }
          initialSeg0Mp4 = {
            mp4Bytes: built.mp4Bytes,
            startSec: built.startSec,
            durationSec: built.durationSec,
            maxPtsMs,
            nextByteOffset: parsed.consumedBytes > 0 ? parsed.consumedBytes : buf.byteLength,
            carryVideo,
            carryAudio,
            subtitles: parsed.subtitleSamples,
          };
        }
      }

      const meta: CachedMkvStreamMeta = {
        tracks: parsed.tracks,
        timecodeScale: parsed.timecodeScale,
        totalDurationSec: parsed.durationSec,
        totalFileBytes,
        segmentDataOffset: parsed.segmentDataOffset || 52,
        firstClusterOffset: parsed.firstClusterOffset > 0 ? parsed.firstClusterOffset : 1500,
        cuesByteOffset: parsed.cuesByteOffset,
        cuePoints: existing?.cuePoints || [],
        initialSeg0Mp4,
      };
      mkvStreamMetaCache.set(url, meta);

      // 2. Immediately fetch the Cues keyframe index (using exact SeekHead offset or 384 KB tail)
      if (totalFileBytes > 220_000 && meta.cuePoints.length === 0) {
        const tailStart =
          meta.cuesByteOffset > 0 && meta.cuesByteOffset < totalFileBytes
            ? meta.cuesByteOffset
            : Math.max(0, totalFileBytes - 384 * 1024);
        const tailEnd = Math.min(totalFileBytes - 1, tailStart + 220 * 1024 - 1);
        const tailRes = await fetch(url, {
          headers: { Range: `bytes=${tailStart}-${tailEnd}` },
        });
        if (tailRes.ok || tailRes.status === 206) {
          const tailBuf = new Uint8Array(await tailRes.arrayBuffer());
          const cues = parseMkvCuesFromBuffer(
            tailBuf,
            meta.segmentDataOffset,
            meta.timecodeScale
          );
          if (cues.length > 0) {
            meta.cuePoints = cues;
            if (!meta.totalDurationSec && cues.length > 1) {
              meta.totalDurationSec = cues[cues.length - 1].timeMs / 1000 + 4;
            }
            mkvStreamMetaCache.set(url, meta);
          }
        }
      }
      return meta;
    } catch {
      return mkvStreamMetaCache.get(url) || null;
    } finally {
      inFlightMetaPrewarms.delete(url);
    }
  })();

  inFlightMetaPrewarms.set(url, p);
  return p;
}

/**
 * Ultra-Fast HLS-Style Micro-Chunk MKV-to-MP4 Stream Controller
 */
export class IosMkvStreamController {
  private url: string;
  private skipIntroSec: number;
  private initialResumeSec: number;
  private aborted = false;
  private abortController = new AbortController();
  private seekAbortController: AbortController | null = null;
  private bgPrebufferAbortController: AbortController | null = null;

  private tracks: MkvTrackInfo[] = [];
  private timecodeScale = 1_000_000;
  private totalFileBytes = 0;
  private totalDurationSec = 0;
  private segmentDataOffset = 52;
  private cuesByteOffset = -1;
  private cuePoints: MkvCuePoint[] = [];
  private cuesPromise: Promise<MkvCuePoint[]> | null = null;
  private nextByteOffset = 0;
  private eofReached = false;
  private lastEmittedVideoPtsMs = -1;

  private carryVideo: VideoSample[] = [];
  private carryAudio: AudioSample[] = [];
  private extractedSubtitles: MkvSubtitleSample[] = [];

  private segments: RemuxedSegmentItem[] = [];
  private buildingPromise: Promise<RemuxedSegmentItem | null> | null = null;
  private prewarmedSeekSlice: {
    startByte: number;
    endByte: number;
    promise: Promise<Uint8Array | null>;
  } | null = null;

  constructor(url: string, skipIntroSec = 12, initialResumeSec = 0) {
    this.url = url;
    this.skipIntroSec = skipIntroSec;
    this.initialResumeSec = initialResumeSec;
  }

  public destroy() {
    this.aborted = true;
    try {
      this.abortController.abort();
    } catch {
      // ignore
    }
    try {
      this.seekAbortController?.abort();
    } catch {
      // ignore
    }
    try {
      this.bgPrebufferAbortController?.abort();
    } catch {
      // ignore
    }
    for (const seg of this.segments) {
      if (seg.blobUrl) {
        try {
          URL.revokeObjectURL(seg.blobUrl);
        } catch {
          // ignore
        }
      }
    }
    this.segments = [];
    this.carryVideo = [];
    this.carryAudio = [];
    this.prewarmedSeekSlice = null;
  }

  public getTotalDurationSec(): number {
    return this.totalDurationSec;
  }

  public getExtractedSubtitles(): MkvSubtitleSample[] {
    return this.extractedSubtitles;
  }

  private mergeSubtitleSamples(samples: MkvSubtitleSample[]) {
    if (!samples || samples.length === 0) return;
    for (const s of samples) {
      if (
        !this.extractedSubtitles.some(
          (ex) => Math.abs(ex.ptsMs - s.ptsMs) < 120 && ex.text === s.text
        )
      ) {
        this.extractedSubtitles.push(s);
      }
    }
  }

  private ensureCuesTableLoaded(): Promise<MkvCuePoint[]> {
    if (this.cuePoints.length > 0) return Promise.resolve(this.cuePoints);
    const cached = mkvStreamMetaCache.get(this.url);
    if (cached && cached.cuePoints.length > 0) {
      this.cuePoints = cached.cuePoints;
      return Promise.resolve(this.cuePoints);
    }
    if (this.cuesPromise) return this.cuesPromise;
    if (this.totalFileBytes <= 220_000) return Promise.resolve([]);

    this.cuesPromise = (async () => {
      try {
        const hasExactCuesOffset =
          this.cuesByteOffset > 0 && this.cuesByteOffset < this.totalFileBytes;
        const tailStart = hasExactCuesOffset
          ? this.cuesByteOffset
          : Math.max(0, this.totalFileBytes - 320 * 1024);
        const maxWindow = hasExactCuesOffset ? 140 * 1024 : 220 * 1024;
        const tailEnd = Math.min(this.totalFileBytes - 1, tailStart + maxWindow - 1);
        const res = await fetch(this.url, {
          signal: this.abortController.signal,
          headers: {
            Range: `bytes=${tailStart}-${tailEnd}`,
          },
        });
        if (!res.ok && res.status !== 206) return [];
        const tailBuf = new Uint8Array(await res.arrayBuffer());
        if (this.aborted) return [];
        const cues = parseMkvCuesFromBuffer(
          tailBuf,
          this.segmentDataOffset,
          this.timecodeScale
        );
        if (cues.length > 0) {
          this.cuePoints = cues;
          if (!this.totalDurationSec && cues.length > 1) {
            this.totalDurationSec = cues[cues.length - 1].timeMs / 1000 + 4;
          }
          const existingMeta = mkvStreamMetaCache.get(this.url);
          if (existingMeta) {
            existingMeta.cuePoints = cues;
            if (!existingMeta.totalDurationSec && this.totalDurationSec > 0) {
              existingMeta.totalDurationSec = this.totalDurationSec;
            }
          }
        }
        return cues;
      } catch {
        return [];
      } finally {
        this.cuesPromise = null;
      }
    })();

    return this.cuesPromise;
  }

  /**
   * Finds the exact [startByte, endByte] Cluster range from the Matroska Cues table
   * for any target timestamp (in seconds) with a desired chunk byte & duration budget.
   */
  private findExactCueByteRange(
    targetSec: number,
    minBytes = 650_000,
    maxBytes = 1_350_000,
    minDurationMs = 11000,
    preferAtOrAfter = false
  ): { startByte: number; endByte: number; exactAligned: boolean } | null {
    if (this.cuePoints.length < 2) return null;
    const targetMs = Math.max(0, targetSec * 1000);

    let startIdx = 0;
    if (preferAtOrAfter) {
      const idx = this.cuePoints.findIndex((c) => c.timeMs >= Math.max(0, targetMs - 500));
      startIdx = idx !== -1 ? idx : 0;
    } else {
      let lo = 0;
      let hi = this.cuePoints.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (this.cuePoints[mid].timeMs <= targetMs) {
          startIdx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
    }

    const startCue = this.cuePoints[startIdx];
    const startByte = startCue.byteOffset;

    let endIdx = startIdx + 1;
    while (endIdx < this.cuePoints.length) {
      const cand = this.cuePoints[endIdx];
      const byteSpan = cand.byteOffset - startByte;
      const durSpan = cand.timeMs - startCue.timeMs;
      if (durSpan >= minDurationMs && byteSpan >= minBytes) {
        break;
      }
      if (durSpan >= minDurationMs * 1.4 || byteSpan >= maxBytes) {
        if (durSpan >= Math.min(8000, minDurationMs)) {
          break;
        }
      }
      if (byteSpan >= maxBytes * 1.65) {
        break;
      }
      endIdx++;
    }

    if (endIdx < this.cuePoints.length) {
      const nextClusterStart = this.cuePoints[endIdx].byteOffset;
      if (nextClusterStart > startByte + 32_768) {
        return {
          startByte,
          endByte: nextClusterStart - 1,
          exactAligned: true,
        };
      }
    }

    const fallbackEnd =
      this.totalFileBytes > 0
        ? Math.min(this.totalFileBytes - 1, startByte + maxBytes - 1)
        : startByte + maxBytes - 1;
    return {
      startByte,
      endByte: fallbackEnd,
      exactAligned: false,
    };
  }

  public prewarmSeekTarget(_targetSec: number): void {
    // Intentionally keep network 100% free while finger is dragging across the seekbar
    // so the committed seek on release executes with zero connection contention!
  }

  public getPrebufferedSegmentUrl(targetIndex: number): string {
    const found = this.segments.find((s) => s.index === targetIndex && s.blobUrl);
    return found ? found.blobUrl : '';
  }

  public async startInitialSegment(): Promise<RemuxedSegmentItem> {
    this.lastEmittedVideoPtsMs = -1;
    const isResumeJump = this.initialResumeSec > 15;

    // 0ms RAM INSTANT STARTUP: If prewarmMkvStreamMeta already built Segment 0 in RAM, return it in 0ms!
    if (!isResumeJump) {
      const prewarmed = mkvStreamMetaCache.get(this.url);
      if (prewarmed && prewarmed.tracks.length > 0 && prewarmed.initialSeg0Mp4) {
        this.tracks = prewarmed.tracks;
        this.timecodeScale = prewarmed.timecodeScale;
        this.totalDurationSec = prewarmed.totalDurationSec;
        this.totalFileBytes = prewarmed.totalFileBytes;
        this.segmentDataOffset = prewarmed.segmentDataOffset || 52;
        this.cuesByteOffset = prewarmed.cuesByteOffset;
        this.cuePoints = prewarmed.cuePoints || [];

        const init0 = prewarmed.initialSeg0Mp4;
        this.lastEmittedVideoPtsMs = init0.maxPtsMs;
        this.nextByteOffset = init0.nextByteOffset;
        this.carryVideo = [...init0.carryVideo];
        this.carryAudio = [...init0.carryAudio];
        this.mergeSubtitleSamples(init0.subtitles);
        if (this.totalFileBytes > 0 && this.nextByteOffset >= this.totalFileBytes) {
          this.eofReached = true;
        }

        const blob = new Blob([init0.mp4Bytes as unknown as BlobPart], {
          type: 'video/mp4',
        });
        const seg0: RemuxedSegmentItem = {
          index: 0,
          blobUrl: URL.createObjectURL(blob),
          startSec: init0.startSec,
          durationSec: init0.durationSec,
        };
        this.segments.push(seg0);
        this.ensureNextSegmentPrebuffered(1, 0);
        if (this.cuePoints.length === 0) {
          this.ensureCuesTableLoaded();
        }
        return seg0;
      }

      // ULTRA-FAST 1-REQUEST STARTUP (~160ms):
      // Fetch 680 KB (header + Tracks + Cluster #0-#1) in a SINGLE HTTP Range request for 8-12s initial cushion!
      const SINGLE_SHOT_BYTES = 680 * 1024;
      const res = await fetch(this.url, {
        signal: this.abortController.signal,
        headers: {
          Range: `bytes=0-${SINGLE_SHOT_BYTES - 1}`,
        },
      });
      if (!res.ok && res.status !== 206) {
        throw new Error(`HTTP ${res.status}`);
      }
      const contentRange = res.headers.get('content-range') || '';
      const totalMatch = contentRange.match(/\/(\d+)/);
      if (totalMatch) {
        this.totalFileBytes = Number(totalMatch[1]);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (this.aborted) throw new Error('Aborted');

      const parsed = parseMkvHeaderAndSamples(buf);
      if (parsed.tracks.length > 0) this.tracks = parsed.tracks;
      this.timecodeScale = parsed.timecodeScale;
      this.segmentDataOffset = parsed.segmentDataOffset || 52;
      this.cuesByteOffset = parsed.cuesByteOffset;
      if (parsed.durationSec > 0) {
        this.totalDurationSec = parsed.durationSec;
      }
      this.mergeSubtitleSamples(parsed.subtitleSamples);

      const existingMeta = mkvStreamMetaCache.get(this.url);
      if (existingMeta && existingMeta.cuePoints.length > 0) {
        this.cuePoints = existingMeta.cuePoints;
      } else {
        mkvStreamMetaCache.set(this.url, {
          tracks: this.tracks,
          timecodeScale: this.timecodeScale,
          totalDurationSec: this.totalDurationSec,
          totalFileBytes: this.totalFileBytes,
          segmentDataOffset: this.segmentDataOffset,
          firstClusterOffset: parsed.firstClusterOffset > 0 ? parsed.firstClusterOffset : 1500,
          cuesByteOffset: this.cuesByteOffset,
          cuePoints: [],
        });
        // Load Cues keyframe index in the background immediately so seeking is 0-wait ready!
        this.ensureCuesTableLoaded();
      }

      const primaryVTrack = this.tracks.find((t) => t.type === 1);
      if (
        primaryVTrack &&
        /AV1/i.test(primaryVTrack.codecId) &&
        typeof document !== 'undefined'
      ) {
        const canPlayAv1 = document
          .createElement('video')
          .canPlayType('video/mp4; codecs="av01.0.05M.08"');
        if (!canPlayAv1) {
          throw new Error('AV1 codec unsupported on this iOS device; switching to H.264');
        }
      }

      if (parsed.videoSamples.length >= 2) {
        const endedAtCompleteCluster =
          parsed.consumedBytes > 0 && parsed.consumedBytes < buf.byteLength;
        this.nextByteOffset =
          parsed.consumedBytes > 0 ? parsed.consumedBytes : buf.byteLength;
        if (this.totalFileBytes > 0 && this.nextByteOffset >= this.totalFileBytes) {
          this.eofReached = true;
        }
        const seg0 = this.finalizeSegmentFromSamples(
          0,
          parsed.videoSamples,
          parsed.audioSamples,
          endedAtCompleteCluster
        );
        if (seg0) {
          this.segments.push(seg0);
          // Immediately pipeline Segment #1 (and Segment #2) in the background!
          this.ensureNextSegmentPrebuffered(1, 0);
          return seg0;
        }
      }
    }

    let meta = mkvStreamMetaCache.get(this.url);
    if (!meta || meta.tracks.length === 0) {
      const HEADER_PROBE_BYTES = 16 * 1024;
      const headRes = await fetch(this.url, {
        signal: this.abortController.signal,
        headers: {
          Range: `bytes=0-${HEADER_PROBE_BYTES - 1}`,
        },
      });
      if (!headRes.ok && headRes.status !== 206) {
        throw new Error(`HTTP ${headRes.status}`);
      }
      const contentRange = headRes.headers.get('content-range') || '';
      const totalMatch = contentRange.match(/\/(\d+)/);
      if (totalMatch) {
        this.totalFileBytes = Number(totalMatch[1]);
      }
      const headBuf = new Uint8Array(await headRes.arrayBuffer());
      if (this.aborted) throw new Error('Aborted');

      const parsedHead = parseMkvHeaderAndSamples(headBuf);
      this.tracks = parsedHead.tracks;
      this.timecodeScale = parsedHead.timecodeScale;
      this.segmentDataOffset = parsedHead.segmentDataOffset || 52;
      this.cuesByteOffset = parsedHead.cuesByteOffset;
      if (parsedHead.durationSec > 0) {
        this.totalDurationSec = parsedHead.durationSec;
      }
      meta = {
        tracks: this.tracks,
        timecodeScale: this.timecodeScale,
        totalDurationSec: this.totalDurationSec,
        totalFileBytes: this.totalFileBytes,
        segmentDataOffset: this.segmentDataOffset,
        firstClusterOffset: parsedHead.firstClusterOffset > 0 ? parsedHead.firstClusterOffset : 1500,
        cuesByteOffset: this.cuesByteOffset,
        cuePoints: [],
      };
      mkvStreamMetaCache.set(this.url, meta);
    } else {
      this.tracks = meta.tracks;
      this.timecodeScale = meta.timecodeScale;
      this.totalDurationSec = meta.totalDurationSec;
      this.totalFileBytes = meta.totalFileBytes;
      this.segmentDataOffset = meta.segmentDataOffset || 52;
      this.cuesByteOffset = meta.cuesByteOffset;
      if (meta.cuePoints.length > 0) {
        this.cuePoints = meta.cuePoints;
      }
    }

    const primaryVTrack = this.tracks.find((t) => t.type === 1);
    if (
      primaryVTrack &&
      /AV1/i.test(primaryVTrack.codecId) &&
      typeof document !== 'undefined'
    ) {
      const canPlayAv1 = document
        .createElement('video')
        .canPlayType('video/mp4; codecs="av01.0.05M.08"');
      if (!canPlayAv1) {
        throw new Error('AV1 codec unsupported on this iOS device; switching to H.264');
      }
    }

    if (this.cuePoints.length === 0 && this.totalFileBytes > 220_000) {
      const cuesRace = Promise.race([
        this.ensureCuesTableLoaded(),
        new Promise<MkvCuePoint[]>((r) => setTimeout(() => r([]), 2200)),
      ]);
      await cuesRace;
    } else if (this.cuePoints.length === 0) {
      this.ensureCuesTableLoaded();
    }

    const wantStartSec = isResumeJump ? this.initialResumeSec : 0;

    // 2. FAST PATH A: Exact CuePoint Cluster Jump (~650 KB - 1.15 MB, ~12-18s of video!)
    if (this.cuePoints.length >= 2) {
      const cueRange = this.findExactCueByteRange(
        wantStartSec,
        650_000,
        1_250_000,
        11000,
        false
      );
      if (cueRange) {
        const res = await fetch(this.url, {
          signal: this.abortController.signal,
          headers: {
            Range: `bytes=${cueRange.startByte}-${cueRange.endByte}`,
          },
        });
        if (res.ok || res.status === 206) {
          const buf = new Uint8Array(await res.arrayBuffer());
          if (this.aborted) throw new Error('Aborted');
          const parsed = parseMkvHeaderAndSamples(buf, this.tracks, this.timecodeScale);
          this.mergeSubtitleSamples(parsed.subtitleSamples);
          const endedAtCompleteCluster =
            cueRange.exactAligned ||
            (parsed.consumedBytes > 0 && parsed.consumedBytes < buf.byteLength);
          this.nextByteOffset = cueRange.exactAligned
            ? cueRange.endByte + 1
            : cueRange.startByte + parsed.consumedBytes;
          this.eofReached =
            this.totalFileBytes > 0 && this.nextByteOffset >= this.totalFileBytes;

          let vSamples = parsed.videoSamples;
          let aSamples = parsed.audioSamples;
          if (vSamples.length > 0) {
            const firstKf = vSamples.findIndex((s) => s.keyframe);
            if (firstKf > 0) {
              const cutPts = vSamples[firstKf].ptsMs;
              vSamples = vSamples.slice(firstKf);
              aSamples = aSamples.filter((a) => a.ptsMs >= cutPts - 20);
            } else if (firstKf === -1) {
              vSamples[0].keyframe = true;
            }
          }

          const seg0 = this.finalizeSegmentFromSamples(
            0,
            vSamples,
            aSamples,
            endedAtCompleteCluster
          );
          if (seg0) {
            this.segments.push(seg0);
            this.ensureNextSegmentPrebuffered(1);
            return seg0;
          }
        }
      }
    }

    // 3. FAST PATH B: Fallback 1.6 MB burst if Cues table wasn't present
    const FALLBACK_INITIAL_BYTES = 1_650_000;
    let fallbackStartByte = 0;
    if (
      wantStartSec > 20 &&
      this.totalDurationSec > 60 &&
      this.totalFileBytes > 3_000_000
    ) {
      fallbackStartByte = Math.max(
        0,
        Math.floor((wantStartSec / this.totalDurationSec) * this.totalFileBytes)
      );
    }
    const fallbackEndByte =
      this.totalFileBytes > 0
        ? Math.min(this.totalFileBytes - 1, fallbackStartByte + FALLBACK_INITIAL_BYTES - 1)
        : fallbackStartByte + FALLBACK_INITIAL_BYTES - 1;

    const res = await fetch(this.url, {
      signal: this.abortController.signal,
      headers: {
        Range: `bytes=${fallbackStartByte}-${fallbackEndByte}`,
      },
    });

    if (!res.ok && res.status !== 206) {
      throw new Error(`HTTP ${res.status}`);
    }

    const buf = new Uint8Array(await res.arrayBuffer());
    if (this.aborted) throw new Error('Aborted');

    const parsed = parseMkvHeaderAndSamples(
      buf,
      this.tracks.length > 0 ? this.tracks : undefined,
      this.timecodeScale
    );
    if (parsed.tracks.length > 0) this.tracks = parsed.tracks;
    this.timecodeScale = parsed.timecodeScale;
    if (parsed.durationSec > 0) this.totalDurationSec = parsed.durationSec;
    this.mergeSubtitleSamples(parsed.subtitleSamples);

    const endedAtCompleteCluster =
      parsed.consumedBytes > 0 && parsed.consumedBytes < buf.byteLength;
    this.nextByteOffset = fallbackStartByte + parsed.consumedBytes;
    if (this.totalFileBytes > 0 && this.nextByteOffset >= this.totalFileBytes) {
      this.eofReached = true;
    }

    let vSamples = parsed.videoSamples;
    let aSamples = parsed.audioSamples;

    if (fallbackStartByte > 0) {
      const firstKf = vSamples.findIndex((s) => s.keyframe);
      if (firstKf > 0) {
        const cutPts = vSamples[firstKf].ptsMs;
        vSamples = vSamples.slice(firstKf);
        aSamples = aSamples.filter((a) => a.ptsMs >= cutPts - 20);
      } else if (firstKf === -1 && vSamples.length > 0) {
        vSamples[0].keyframe = true;
      }
    }

    const seg0 = this.finalizeSegmentFromSamples(
      0,
      vSamples,
      aSamples,
      endedAtCompleteCluster
    );
    if (!seg0) {
      throw new Error('Unsupported MKV codec or empty segment');
    }

    this.segments.push(seg0);
    this.ensureNextSegmentPrebuffered(1);

    return seg0;
  }

  private finalizeSegmentFromSamples(
    segIndex: number,
    vAll: VideoSample[],
    aAll: AudioSample[],
    exactClusterAligned = false
  ): RemuxedSegmentItem | null {
    // Enforce strict monotonic PTS continuity across sequential segments so playback NEVER jumps backwards!
    let vFiltered = vAll;
    let aFiltered = aAll;
    if (segIndex > 0 && this.lastEmittedVideoPtsMs > 0) {
      const minNextPts = this.lastEmittedVideoPtsMs - 5;
      const firstValidKf = vFiltered.findIndex(
        (s) => s.keyframe && s.ptsMs >= minNextPts
      );
      if (firstValidKf > 0) {
        vFiltered = vFiltered.slice(firstValidKf);
      } else if (firstValidKf === -1) {
        vFiltered = vFiltered.filter((s) => s.ptsMs > minNextPts);
      }
      if (vFiltered.length > 0) {
        if (!vFiltered[0].keyframe) {
          const kfIdx = vFiltered.findIndex((s) => s.keyframe);
          if (kfIdx > 0) {
            vFiltered = vFiltered.slice(kfIdx);
          } else {
            vFiltered[0].keyframe = true;
          }
        }
        const cutPts = vFiltered[0].ptsMs;
        aFiltered = aFiltered.filter((a) => a.ptsMs >= cutPts - 20);
      }
    }

    if (vFiltered.length < 2) return null;

    let vForSeg = vFiltered;
    let aForSeg = aFiltered;

    if (!exactClusterAligned && !this.eofReached) {
      let lastKeyframeIdx = -1;
      for (let i = vFiltered.length - 1; i >= Math.min(25, Math.floor(vFiltered.length * 0.65)); i--) {
        if (vFiltered[i].keyframe) {
          lastKeyframeIdx = i;
          break;
        }
      }
      if (lastKeyframeIdx > 15 && lastKeyframeIdx < vFiltered.length - 1) {
        const splitPtsMs = vFiltered[lastKeyframeIdx].ptsMs;
        vForSeg = vFiltered.slice(0, lastKeyframeIdx);
        this.carryVideo = vFiltered.slice(lastKeyframeIdx);
        aForSeg = aFiltered.filter((a) => a.ptsMs < splitPtsMs);
        this.carryAudio = aFiltered.filter((a) => a.ptsMs >= splitPtsMs);
      } else {
        this.carryVideo = [];
        this.carryAudio = [];
      }
    } else {
      this.carryVideo = [];
      this.carryAudio = [];
    }

    const built = buildFastStartMp4(this.tracks, vForSeg, aForSeg);
    if (!built) return null;

    let maxPts = this.lastEmittedVideoPtsMs;
    for (const s of vForSeg) {
      if (s.ptsMs > maxPts) maxPts = s.ptsMs;
    }
    this.lastEmittedVideoPtsMs = maxPts;

    const blob = new Blob([built.mp4Bytes as unknown as BlobPart], {
      type: 'video/mp4',
    });
    const blobUrl = URL.createObjectURL(blob);

    return {
      index: segIndex,
      blobUrl,
      startSec: built.startSec,
      durationSec: built.durationSec,
    };
  }

  public ensureNextSegmentPrebuffered(
    targetIndex: number,
    chainDepth = 0
  ): Promise<RemuxedSegmentItem | null> {
    const existing = this.segments.find((s) => s.index === targetIndex && s.blobUrl);
    if (existing) {
      if (chainDepth < 1 && !this.eofReached && !this.aborted) {
        const nextAhead = this.segments.find((s) => s.index === targetIndex + 1 && s.blobUrl);
        if (!nextAhead && !this.buildingPromise) {
          void this.ensureNextSegmentPrebuffered(targetIndex + 1, chainDepth + 1);
        }
      }
      return Promise.resolve(existing);
    }
    if (this.buildingPromise) return this.buildingPromise;
    if (this.eofReached && this.carryVideo.length === 0) return Promise.resolve(null);

    this.buildingPromise = (async () => {
      const bgCtrl = new AbortController();
      this.bgPrebufferAbortController = bgCtrl;
      try {
        let vCombined = [...this.carryVideo];
        let aCombined = [...this.carryAudio];
        this.carryVideo = [];
        this.carryAudio = [];
        let exactAligned = false;

        if (!this.eofReached) {
          const rangeStart = this.nextByteOffset;
          const desiredBytes = 3_600_000;
          let rangeEnd =
            this.totalFileBytes > 0
              ? Math.min(this.totalFileBytes - 1, rangeStart + desiredBytes - 1)
              : rangeStart + desiredBytes - 1;

          if (this.cuePoints.length >= 2) {
            const nextCue = this.cuePoints.find(
              (c) =>
                c.byteOffset >= rangeStart + 2_200_000 &&
                c.byteOffset <= rangeStart + desiredBytes + 1_400_000
            );
            if (nextCue) {
              rangeEnd = nextCue.byteOffset - 1;
              exactAligned = true;
            }
          }

          const res = await fetch(this.url, {
            signal: bgCtrl.signal,
            headers: {
              Range: `bytes=${rangeStart}-${rangeEnd}`,
            },
          });

          if (res.ok || res.status === 206) {
            const buf = new Uint8Array(await res.arrayBuffer());
            if (this.aborted || bgCtrl.signal.aborted) return null;

            const parsed = parseMkvHeaderAndSamples(
              buf,
              this.tracks,
              this.timecodeScale
            );
            this.mergeSubtitleSamples(parsed.subtitleSamples);
            const endedAtCompleteCluster =
              exactAligned ||
              (parsed.consumedBytes > 0 && parsed.consumedBytes < buf.byteLength);
            this.nextByteOffset = exactAligned
              ? rangeEnd + 1
              : rangeStart + parsed.consumedBytes;
            exactAligned = endedAtCompleteCluster;
            if (
              (this.totalFileBytes > 0 && this.nextByteOffset >= this.totalFileBytes) ||
              parsed.videoSamples.length === 0
            ) {
              this.eofReached = true;
            }
            vCombined = vCombined.concat(parsed.videoSamples);
            aCombined = aCombined.concat(parsed.audioSamples);
          } else {
            this.eofReached = true;
          }
        }

        const seg = this.finalizeSegmentFromSamples(
          targetIndex,
          vCombined,
          aCombined,
          exactAligned
        );
        if (seg) {
          this.segments.push(seg);
          if (this.segments.length > 6) {
            const toRemove = this.segments.slice(0, this.segments.length - 6);
            for (const old of toRemove) {
              if (old.blobUrl) {
                try {
                  URL.revokeObjectURL(old.blobUrl);
                } catch {
                  // ignore
                }
                old.blobUrl = '';
              }
            }
            this.segments = this.segments.filter((s) => Boolean(s.blobUrl));
          }
        }
        return seg;
      } catch {
        return null;
      } finally {
        this.buildingPromise = null;
        if (this.bgPrebufferAbortController === bgCtrl) {
          this.bgPrebufferAbortController = null;
        }
        // Automatically pipeline the 2nd segment ahead so ~35 seconds of video stay pre-remuxed in RAM!
        if (chainDepth < 1 && !this.aborted && !this.eofReached) {
          void this.ensureNextSegmentPrebuffered(targetIndex + 1, chainDepth + 1);
        }
      }
    })();

    return this.buildingPromise;
  }

  public async seekToSeconds(targetSec: number): Promise<RemuxedSegmentItem | null> {
    if (this.totalDurationSec <= 0 && this.totalFileBytes <= 0) {
      return null;
    }

    const maxDur = this.totalDurationSec > 0 ? this.totalDurationSec : 99999;
    const clampedSec = Math.max(0, Math.min(maxDur - 2, targetSec));

    // Abort any previous in-flight seek or background prebuffer immediately so 100% of bandwidth goes to this seek!
    try {
      this.seekAbortController?.abort();
    } catch {
      // ignore
    }
    try {
      this.bgPrebufferAbortController?.abort();
    } catch {
      // ignore
    }
    this.buildingPromise = null;

    const seekCtrl = new AbortController();
    this.seekAbortController = seekCtrl;

    try {
      // Ensure Cues table is loaded (wait up to 2200ms so seeking ALWAYS has exact keyframe Cluster offsets!)
      if (this.cuePoints.length === 0 && this.totalFileBytes > 220_000) {
        await Promise.race([
          this.ensureCuesTableLoaded(),
          new Promise<MkvCuePoint[]>((r) => setTimeout(() => r([]), 2200)),
        ]);
      }

      let startByte = 0;
      let endByte = 0;
      let exactAligned = false;

      // Exact CuePoint Lookup (~550 KB - 1.1 MB micro-chunk for ~10-16s of video!)
      const cueRange = this.findExactCueByteRange(clampedSec, 550_000, 1_150_000, 10000, false);
      if (cueRange) {
        startByte = cueRange.startByte;
        endByte = cueRange.endByte;
        exactAligned = cueRange.exactAligned;
      } else {
        const approxRatio = this.totalDurationSec > 0 ? clampedSec / this.totalDurationSec : 0;
        startByte = Math.max(0, Math.floor(approxRatio * this.totalFileBytes));
        const FALLBACK_SEEK_BYTES = 1_850_000;
        endByte =
          this.totalFileBytes > 0
            ? Math.min(this.totalFileBytes - 1, startByte + FALLBACK_SEEK_BYTES - 1)
            : startByte + FALLBACK_SEEK_BYTES - 1;
      }

      const res = await fetch(this.url, {
        signal: seekCtrl.signal,
        headers: {
          Range: `bytes=${startByte}-${endByte}`,
        },
      });
      if (!res.ok && res.status !== 206) return null;
      const buf = new Uint8Array(await res.arrayBuffer());

      if (this.aborted || seekCtrl.signal.aborted) return null;

      const parsed = parseMkvHeaderAndSamples(
        buf,
        this.tracks,
        this.timecodeScale
      );
      this.mergeSubtitleSamples(parsed.subtitleSamples);
      const endedAtCompleteCluster =
        exactAligned ||
        (parsed.consumedBytes > 0 && parsed.consumedBytes < buf.byteLength);
      this.nextByteOffset = exactAligned
        ? endByte + 1
        : startByte + parsed.consumedBytes;
      this.eofReached =
        this.totalFileBytes > 0 && this.nextByteOffset >= this.totalFileBytes;

      if (parsed.videoSamples.length === 0) return null;
      let firstKfIdx = parsed.videoSamples.findIndex((s) => s.keyframe);
      if (firstKfIdx === -1) {
        parsed.videoSamples[0].keyframe = true;
        firstKfIdx = 0;
      }

      const cutPts = parsed.videoSamples[firstKfIdx].ptsMs;
      const vSamples = parsed.videoSamples.slice(firstKfIdx);
      const aSamples = parsed.audioSamples.filter((a) => a.ptsMs >= cutPts - 20);

      // Reset monotonic PTS tracker and clear old prebuffered segments on explicit user seek!
      this.lastEmittedVideoPtsMs = -1;
      this.carryVideo = [];
      this.carryAudio = [];
      for (const old of this.segments) {
        if (old.blobUrl) {
          try {
            URL.revokeObjectURL(old.blobUrl);
          } catch {
            // ignore
          }
          old.blobUrl = '';
        }
      }
      this.segments = [];

      const newIdx = Math.floor(Date.now() % 100000);
      const seg = this.finalizeSegmentFromSamples(
        newIdx,
        vSamples,
        aSamples,
        endedAtCompleteCluster
      );
      if (seg) {
        this.segments.push(seg);
        this.ensureNextSegmentPrebuffered(newIdx + 1);
      }
      return seg;
    } catch {
      return null;
    }
  }
}
