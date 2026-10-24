// ---------------------------------------------------------------------------
// Builds a Final Cut Pro XML (FCPXML 1.9) from a logged show plus the camera
// files. FCP can't import EDLs, so the timeline is described directly: one
// asset per camera file (with its real start timecode) and one asset-clip per
// switch, with markers attached to the clip they fall in. Opens in Final Cut
// Pro 10.5+ (File ▸ Import ▸ XML) and also in DaVinci Resolve.
// ---------------------------------------------------------------------------
import { promises as fs } from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { MediaInfo, findReelMedia, readMediaInfo } from './media-info.js';
import { framesToTc } from './edl-logger.js';

/** The .json journal the logger writes next to every EDL. */
export interface Session {
  title: string;
  dropFrame: boolean;
  fpsBase?: number;
  fpsReal?: number;
  recordStartFrame?: number;
  endFrame?: number;
  events: { frame: number; reel: string; name: string; timecode: string }[];
  markers: { frame: number; note: string }[];
}

export interface FcpxmlResult { file: string; clips: number; markers: number; media: Record<string, string>; warnings: string[]; }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function buildFcpxmlFile(jsonFile: string, mediaDir: string): Promise<FcpxmlResult> {
  const session: Session = JSON.parse(await fs.readFile(jsonFile, 'utf-8'));
  if (!session.events?.length) throw new Error('That log has no switches in it.');
  const reels = [...new Set(session.events.map(e => e.reel))];
  const found = await findReelMedia(mediaDir, reels);
  const missing = reels.filter(r => !found.has(r) && r !== 'BL');
  if (missing.length) {
    throw new Error(`Couldn't find camera file${missing.length > 1 ? 's' : ''} named ${missing.map(r => `${r}.mov`).join(', ')} in ${mediaDir} (or its subfolders). ` +
      `Rename the camera files to match their reel names, or choose the folder that contains them.`);
  }
  const media = new Map<string, MediaInfo>();
  for (const [reel, file] of found) media.set(reel, await readMediaInfo(file));
  const { xml, clips, warnings } = buildFcpxml(session, media);
  const out = jsonFile.replace(/\.json$/i, '.fcpxml');
  await fs.writeFile(out, xml, 'utf-8');
  return { file: out, clips, markers: session.markers.length, media: Object.fromEntries(found), warnings };
}

export function buildFcpxml(session: Session, media: Map<string, MediaInfo>): { xml: string; clips: number; warnings: string[] } {
  const base = session.fpsBase ?? 30;
  const ntsc = session.fpsReal ? session.fpsReal % 1 !== 0 : true;
  const df = session.dropFrame;
  // Rational time for a frame count, e.g. 30 frames at 29.97 → "30030/30000s"
  const t = (frames: number) => (ntsc ? `${frames * 1001}/${base * 1000}s` : `${frames}/${base}s`);
  const tcFormat = df ? 'DF' : 'NDF';
  const warnings: string[] = [];

  const evs = session.events.map(e => ({ ...e, f: Math.round(e.frame) }));
  const first = evs[0].f;
  const end = Math.round(session.endFrame ?? evs[evs.length - 1].frame + base);
  const recStart = Math.round(session.recordStartFrame ?? 0);

  const any = media.values().next().value as MediaInfo;
  const formatId = 'r1';
  const assetId = new Map<string, string>();
  let n = 2;
  const resources: string[] = [`    <format id="${formatId}" frameDuration="${t(1)}" width="${any.width}" height="${any.height}"/>`];
  for (const [reel, m] of media) {
    const id = `r${n++}`;
    assetId.set(reel, id);
    const audio = m.hasAudio ? ` hasAudio="1" audioSources="1" audioChannels="${m.audioChannels || 2}" audioRate="${m.audioRate || 48000}"` : '';
    resources.push(
      `    <asset id="${id}" name="${esc(reel)}" start="${t(m.startFrame)}" duration="${t(m.durationFrames)}" hasVideo="1" format="${formatId}"${audio}>`,
      `      <media-rep kind="original-media" src="${esc(pathToFileURL(m.file).href)}"/>`,
      `    </asset>`);
  }

  const spine: string[] = [];
  let clips = 0, gapFrames = 0;
  const pending = [...session.markers].map(m => ({ f: Math.round(m.frame), note: m.note })).sort((a, b) => a.f - b.f);
  const gap = (off: number, len: number) => {
    spine.push(`        <gap name="Gap" offset="${t(off)}" start="${t(0)}" duration="${t(len)}"/>`);
    gapFrames += len;
  };
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    const next = i + 1 < evs.length ? evs[i + 1].f : end;
    let remaining = next - ev.f;
    if (remaining <= 0) continue;
    let off = recStart + (ev.f - first);
    let src = ev.f;                                   // source timecode = logged switcher timecode
    const m = media.get(ev.reel);
    if (!m) { gap(off, remaining); continue; }
    const head = Math.min(remaining, Math.max(0, m.startFrame - src));
    if (head > 0) {
      warnings.push(`${ev.reel} starts after ${ev.timecode}; the first ${head} frames of that shot are black.`);
      gap(off, head); src += head; off += head; remaining -= head;
      if (remaining <= 0) continue;
    }
    const usable = Math.min(remaining, Math.max(0, m.startFrame + m.durationFrames - src));
    if (usable > 0) {
      const marks = pending.filter(mk => mk.f >= src && mk.f < src + usable)
        .map(mk => `          <marker start="${t(mk.f)}" duration="${t(1)}" value="${esc(mk.note)}"/>`);
      if (marks.length) {
        spine.push(`        <asset-clip ref="${assetId.get(ev.reel)}" name="${esc(ev.reel)}" offset="${t(off)}" start="${t(src)}" duration="${t(usable)}" tcFormat="${tcFormat}">`,
          ...marks, '        </asset-clip>');
      } else {
        spine.push(`        <asset-clip ref="${assetId.get(ev.reel)}" name="${esc(ev.reel)}" offset="${t(off)}" start="${t(src)}" duration="${t(usable)}" tcFormat="${tcFormat}"/>`);
      }
      clips++;
    }
    if (usable < remaining) {
      warnings.push(`${ev.reel} ends before the shot at ${ev.timecode} finishes; the last ${remaining - usable} frames are black.`);
      gap(off + usable, remaining - usable);
    }
  }
  if (gapFrames) warnings.push(`In total ${framesToTc(gapFrames, base, false)} of the timeline is black (no camera media for those moments).`);

  const total = end - first;
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '<fcpxml version="1.9">',
    '  <resources>', ...resources, '  </resources>',
    '  <library>',
    `    <event name="${esc(session.title)}">`,
    `      <project name="${esc(session.title)}">`,
    `        <sequence format="${formatId}" duration="${t(total)}" tcStart="${t(recStart)}" tcFormat="${tcFormat}" audioLayout="stereo" audioRate="48k">`,
    '          <spine>',
    ...spine.map(l => '    ' + l),
    '          </spine>',
    '        </sequence>',
    '      </project>',
    '    </event>',
    '  </library>',
    '</fcpxml>',
    '',
  ].join('\n');
  return { xml, clips, warnings };
}
