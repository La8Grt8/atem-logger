// ---------------------------------------------------------------------------
// Reads what the FCPXML export needs from a QuickTime / MP4 camera file:
// start timecode (from the tmcd track), length, frame size and audio layout.
// Only the small header atoms are read, never the media itself, so it is fast
// even on 100+ GB recordings and on network drives.
// ---------------------------------------------------------------------------
import { promises as fs } from 'fs';
import * as path from 'path';

export interface MediaInfo {
  file: string;
  startFrame: number;        // first frame's timecode, as a frame count since 00:00:00:00
  tcDropFrame: boolean;
  tcBase: number;            // timecode counting rate (24, 25, 30, 60…)
  fps: number;               // actual frame rate (e.g. 29.97)
  durationFrames: number;    // length in frames
  width: number;
  height: number;
  hasAudio: boolean;
  audioChannels: number;
  audioRate: number;
}

interface Atom { type: string; start: number; size: number; header: number; }

function* atoms(buf: Buffer, from = 0, to = buf.length): Generator<Atom> {
  let p = from;
  while (p + 8 <= to) {
    let size = buf.readUInt32BE(p), header = 8;
    const type = buf.toString('latin1', p + 4, p + 8);
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); header = 16; }
    else if (size === 0) size = to - p;
    if (size < header || p + size > to) return;
    yield { type, start: p, size, header };
    p += size;
  }
}
const child = (buf: Buffer, a: Atom, type: string) => {
  for (const c of atoms(buf, a.start + a.header, a.start + a.size)) if (c.type === type) return c;
  return undefined;
};
const path_ = (buf: Buffer, a: Atom | undefined, ...types: string[]) =>
  types.reduce<Atom | undefined>((cur, t) => (cur ? child(buf, cur, t) : undefined), a);

/** Locates and loads the moov atom (it can be at the start or the end of the file). */
async function readMoov(file: string): Promise<{ moov: Buffer; fd: fs.FileHandle }> {
  const fd = await fs.open(file, 'r');
  const { size } = await fd.stat();
  const head = Buffer.alloc(16);
  let p = 0;
  while (p + 8 <= size) {
    await fd.read(head, 0, 16, p);
    let len = head.readUInt32BE(0), hdr = 8;
    const type = head.toString('latin1', 4, 8);
    if (len === 1) { len = Number(head.readBigUInt64BE(8)); hdr = 16; }
    else if (len === 0) len = size - p;
    if (len < hdr) break;
    if (type === 'moov') {
      if (len > 512 * 1024 * 1024) break;
      const moov = Buffer.alloc(len);
      await fd.read(moov, 0, len, p);
      return { moov, fd };
    }
    p += len;
  }
  await fd.close();
  throw new Error(`${path.basename(file)}: not a QuickTime/MP4 file (no movie header)`);
}

export async function readMediaInfo(file: string): Promise<MediaInfo> {
  const { moov: buf, fd } = await readMoov(file);
  try {
    const moov: Atom = { type: 'moov', start: 0, size: buf.length, header: 8 };
    const info: MediaInfo = { file, startFrame: NaN, tcDropFrame: false, tcBase: 0, fps: 0, durationFrames: 0, width: 0, height: 0, hasAudio: false, audioChannels: 0, audioRate: 0 };
    let videoSeconds = 0;
    for (const trak of atoms(buf, moov.header, buf.length)) {
      if (trak.type !== 'trak') continue;
      const mdia = child(buf, trak, 'mdia');
      const hdlr = path_(buf, mdia, 'hdlr');
      const mdhd = path_(buf, mdia, 'mdhd');
      const stsd = path_(buf, mdia, 'minf', 'stbl', 'stsd');
      if (!hdlr || !mdhd || !stsd) continue;
      const kind = buf.toString('latin1', hdlr.start + hdlr.header + 8, hdlr.start + hdlr.header + 12);
      const v1 = buf[mdhd.start + mdhd.header] === 1;
      const timescale = buf.readUInt32BE(mdhd.start + mdhd.header + (v1 ? 20 : 12));
      const duration = v1 ? Number(buf.readBigUInt64BE(mdhd.start + mdhd.header + 24)) : buf.readUInt32BE(mdhd.start + mdhd.header + 16);
      const entry = stsd.start + stsd.header + 8;                    // first sample description
      if (kind === 'vide') {
        info.width = buf.readUInt16BE(entry + 32);
        info.height = buf.readUInt16BE(entry + 34);
        videoSeconds = duration / timescale;
      } else if (kind === 'soun') {
        info.hasAudio = true;
        const ver = buf.readUInt16BE(entry + 16);
        let ch = buf.readUInt16BE(entry + 24), rate = buf.readUInt32BE(entry + 32) >>> 16;
        if (ver === 2) { rate = Math.round(buf.readDoubleBE(entry + 40)); ch = buf.readUInt32BE(entry + 48); }
        info.audioChannels += ch;
        info.audioRate = info.audioRate || rate || timescale;
      } else if (kind === 'tmcd' && Number.isNaN(info.startFrame)) {
        // tmcd sample description: flags, timescale, frame duration, frames per second (counting base)
        // layout: size, 'tmcd', reserved(6), data ref(2), reserved(4), flags(4), timescale(4), frame duration(4), frames per second(1)
        const flags = buf.readUInt32BE(entry + 20);
        info.tcDropFrame = (flags & 1) === 1;
        const tsc = buf.readUInt32BE(entry + 24), fdur = buf.readUInt32BE(entry + 28);
        if (tsc && fdur) info.fps = tsc / fdur;
        info.tcBase = buf[entry + 32];
        // The single tmcd sample (a 32-bit frame counter) lives at the first chunk offset.
        const stbl = path_(buf, mdia, 'minf', 'stbl')!;
        const stco = child(buf, stbl, 'stco'), co64 = child(buf, stbl, 'co64');
        const off = stco ? buf.readUInt32BE(stco.start + stco.header + 8)
          : co64 ? Number(buf.readBigUInt64BE(co64.start + co64.header + 8)) : -1;
        if (off >= 0) {
          const s = Buffer.alloc(4);
          await fd.read(s, 0, 4, off);
          info.startFrame = s.readUInt32BE(0);
        }
      }
    }
    if (Number.isNaN(info.startFrame)) throw new Error(`${path.basename(file)} has no timecode track`);
    if (!info.width) throw new Error(`${path.basename(file)} has no video track`);
    info.durationFrames = Math.round(videoSeconds * (info.fps || info.tcBase || 30));
    return info;
  } finally {
    await fd.close();
  }
}

const MEDIA_EXT = new Set(['.mov', '.mp4', '.m4v']);

/** Finds the camera file for each reel (file name = reel name, any case) under a folder, a few levels deep. */
export async function findReelMedia(dir: string, reels: string[], depth = 4): Promise<Map<string, string>> {
  const want = new Map(reels.map(r => [r.toLowerCase(), r]));
  const found = new Map<string, string>();
  const walk = async (d: string, level: number) => {
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (level < depth && !/^(proxy|proxies|optimized media|render files|\.)/i.test(e.name)) await walk(full, level + 1);
      } else if (MEDIA_EXT.has(path.extname(e.name).toLowerCase())) {
        const reel = want.get(path.basename(e.name, path.extname(e.name)).toLowerCase());
        if (reel && !found.has(reel)) found.set(reel, full);
      }
    }
  };
  await walk(dir, 0);
  return found;
}
