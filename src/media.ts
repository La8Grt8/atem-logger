// ---------------------------------------------------------------------------
// Camera media lookup for XML exports (Premiere / Final Cut Pro).
// Finds the file for each reel (e.g. CAM1 -> .../Host/CAM1.mov) and reads its
// start timecode, length, frame size and audio from the QuickTime/MP4 headers
// (the `tmcd` timecode track that HyperDecks and most cameras write).
// ---------------------------------------------------------------------------
import { promises as fs } from 'fs';
import * as path from 'path';

export interface MediaInfo {
  path: string;
  name: string;            // file name with extension
  startFrame: number | null; // start timecode as a frame count (null if the file has no timecode track)
  dropFrame: boolean | null;
  durationFrames: number | null;
  seconds: number | null;    // movie length in seconds
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  audioChannels: number | null;
  audioRate: number | null;
}

const MEDIA_EXT = new Set(['.mov', '.mp4', '.m4v', '.mxf']);

/** Finds files named <reel>.<ext> (case-insensitive) under `root`, up to 4 folders deep. */
export async function findMediaByReel(root: string, reels: string[]): Promise<Record<string, string>> {
  const want = new Map(reels.map(r => [r.toUpperCase(), r]));
  const found: Record<string, string> = {};
  async function walk(dir: string, depth: number) {
    let entries: import('fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4 && !/^(proxy|proxies|cache)/i.test(e.name)) await walk(p, depth + 1); continue; }
      const ext = path.extname(e.name).toLowerCase();
      if (!MEDIA_EXT.has(ext)) continue;
      const reel = want.get(path.basename(e.name, path.extname(e.name)).toUpperCase());
      if (reel && !found[reel]) found[reel] = p;
    }
  }
  await walk(root, 0);
  return found;
}

// ----------------------------- QuickTime parsing -----------------------------

interface Atom { type: string; start: number; size: number; header: number; }

async function readAt(fh: fs.FileHandle, pos: number, len: number): Promise<Buffer> {
  const b = Buffer.alloc(len);
  const { bytesRead } = await fh.read(b, 0, len, pos);
  return b.subarray(0, bytesRead);
}

async function childAtoms(fh: fs.FileHandle, start: number, end: number): Promise<Atom[]> {
  const out: Atom[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    const h = await readAt(fh, pos, 16);
    if (h.length < 8) break;
    let size = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    let header = 8;
    if (size === 1) { size = Number(h.readBigUInt64BE(8)); header = 16; }
    else if (size === 0) size = end - pos;
    if (size < header) break;
    out.push({ type, start: pos, size, header });
    pos += size;
  }
  return out;
}

const find = (atoms: Atom[], type: string) => atoms.find(a => a.type === type);
const body = (fh: fs.FileHandle, a: Atom, max = 4096) => readAt(fh, a.start + a.header, Math.min(a.size - a.header, max));
async function kids(fh: fs.FileHandle, a: Atom | undefined) { return a ? childAtoms(fh, a.start + a.header, a.start + a.size) : []; }

/** Reads start timecode, length and basics from a .mov/.mp4. Returns nulls for anything it can't find. */
export async function probeMedia(file: string): Promise<MediaInfo> {
  const info: MediaInfo = {
    path: file, name: path.basename(file), startFrame: null, dropFrame: null, durationFrames: null, seconds: null,
    width: null, height: null, hasAudio: false, audioChannels: null, audioRate: null,
  };
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mxf') return info;                       // MXF isn't parsed; XML exports still reference it by name
  const fh = await fs.open(file, 'r');
  try {
    const stat = await fh.stat();
    const moov = find(await childAtoms(fh, 0, stat.size), 'moov');
    if (!moov) return info;
    let movieSeconds: number | null = null;
    const moovKids = await kids(fh, moov);
    const mvhd = find(moovKids, 'mvhd');
    if (mvhd) {
      const b = await body(fh, mvhd, 32);
      const v1 = b[0] === 1;
      const ts = v1 ? b.readUInt32BE(20) : b.readUInt32BE(12);
      const dur = v1 ? Number(b.readBigUInt64BE(24)) : b.readUInt32BE(16);
      if (ts) { movieSeconds = dur / ts; info.seconds = movieSeconds; }
    }
    for (const trak of moovKids.filter(a => a.type === 'trak')) {
      const tk = await kids(fh, trak);
      const mdia = find(tk, 'mdia'); if (!mdia) continue;
      const md = await kids(fh, mdia);
      const hdlr = find(md, 'hdlr'); if (!hdlr) continue;
      const handler = (await body(fh, hdlr, 12)).toString('latin1', 8, 12);
      const stbl = find(await kids(fh, find(md, 'minf')), 'stbl');
      const st = await kids(fh, stbl);
      const stsd = find(st, 'stsd');
      if (handler === 'vide' && info.width === null) {
        const tkhd = find(tk, 'tkhd');
        if (tkhd) {
          const b = await body(fh, tkhd, 96);
          const off = b[0] === 1 ? 88 : 76;
          if (b.length >= off + 8) { info.width = b.readUInt32BE(off) >>> 16; info.height = b.readUInt32BE(off + 4) >>> 16; }
        }
      } else if (handler === 'soun') {
        info.hasAudio = true;
        if (stsd && info.audioChannels === null) {
          const b = await body(fh, stsd, 64);
          if (b.length >= 8 + 32) {                          // sound sample description (v0 layout)
            info.audioChannels = b.readUInt16BE(8 + 24);
            info.audioRate = b.readUInt32BE(8 + 32) >>> 16;
          }
        }
      } else if (handler === 'tmcd' && stsd && info.startFrame === null) {
        // Timecode sample description: flags (bit0 = drop frame), timescale, frameDuration, numberOfFrames.
        const d = await body(fh, stsd, 64);
        if (d.length < 8 + 34) continue;
        const e = 8;                                         // first entry
        const flags = d.readUInt32BE(e + 20);
        const timescale = d.readUInt32BE(e + 24);
        const frameDuration = d.readUInt32BE(e + 28);
        info.dropFrame = (flags & 1) === 1;
        // The first (and only) sample holds the starting frame number.
        const stco = find(st, 'stco'), co64 = find(st, 'co64');
        let offset: number | null = null;
        if (stco) { const b = await body(fh, stco, 16); if (b.readUInt32BE(4) > 0) offset = b.readUInt32BE(8); }
        else if (co64) { const b = await body(fh, co64, 20); if (b.readUInt32BE(4) > 0) offset = Number(b.readBigUInt64BE(8)); }
        if (offset !== null) info.startFrame = (await readAt(fh, offset, 4)).readUInt32BE(0);
        if (movieSeconds !== null && timescale && frameDuration) info.durationFrames = Math.round(movieSeconds * timescale / frameDuration);
      }
    }
    return info;
  } finally {
    await fh.close();
  }
}
