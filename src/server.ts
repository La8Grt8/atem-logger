// ---------------------------------------------------------------------------
// ATEM Logger — standalone EDL logger app (macOS, Windows, Linux/Docker).
// Connects straight to the switcher, logs every program change on an M/E bus
// to a CMX 3600 EDL (via edl-logger.ts, shared with the ATEM MCP server), and
// serves a small control page at http://<this machine>:9920
// ---------------------------------------------------------------------------
import express from 'express';
import { Atem } from 'atem-connection';
import { promises as fs, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { EdlLogger, AtemLike, Platform, PLATFORMS, frameRateFromVideoMode, framesToTc, tcToFrames } from './edl-logger.js';
import { buildFcpxmlFile } from './fcpxml.js';
import { Updater } from './updater.js';
import { checkTentacles, jamTentacles, readClockTime, tentacleRateFor, AtemAnchor, DeviceReport } from './tentacle-jam.js';
import { formatRate, listTentacles } from './tentacle-usb.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 9920);
const DATA_DIR = process.env.DATA_DIR ?? path.join(os.homedir(), '.atem-logger');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SESSION_FILE = path.join(DATA_DIR, 'active-session.json');
mkdirSync(DATA_DIR, { recursive: true });

// ------------------------------- settings -----------------------------------
interface Settings {
  atemIp: string;
  outputDir: string;
  me: number;                       // 0 = M/E 1
  tcSource: 'atem' | 'clock';
  recordStartTc: string;
  reelNames: Record<string, string>; // input number -> reel name (blank = use ATEM short name)
  lastTitle: string;
  platform: Platform;                // edit software the files are made for
  mediaDir: string;                  // where the camera files are (Final Cut XML); blank = folder above the EDL folder
  tentacle: TentacleSettings;
}
interface TentacleSettings {
  autoJam: boolean;                 // jam each Tentacle as soon as it is plugged in
  setFrameRate: boolean;            // match the Tentacle frame rate to the switcher
  offsetFrames: number;             // fixed correction added to the jammed timecode
  autoCorrect: boolean;             // re-jam once if the read-back is a frame or more off
}
const defaults: Settings = {
  atemIp: process.env.ATEM_IP ?? '192.168.11.240',
  outputDir: process.env.OUTPUT_DIR ?? process.env.ATEM_LOGGER_DEFAULT_OUTPUT ?? path.join(os.homedir(), process.platform === 'win32' ? 'Videos' : 'Movies', 'ATEM EDLs'),
  me: 0,
  tcSource: 'atem',
  recordStartTc: '01:00:00:00',
  reelNames: {},
  lastTitle: '',
  platform: 'resolve',
  mediaDir: '',
  tentacle: { autoJam: true, setFrameRate: true, offsetFrames: 0, autoCorrect: true },
};
function loadSettings(): Settings {
  try {
    const saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
    return { ...defaults, ...saved, tentacle: { ...defaults.tentacle, ...saved.tentacle } };
  } catch { return { ...defaults, tentacle: { ...defaults.tentacle } }; }
}
let settings = loadSettings();
function saveSettings() { writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }

// --------------------------- ATEM connection --------------------------------
const atem = new Atem();
let connected = false;
let connectedSince: Date | null = null;
let lastDisconnect: Date | null = null;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

atem.on('connected', () => { connected = true; connectedSince = new Date(); log(`Connected to ATEM ${settings.atemIp} (${atem.state?.info?.productIdentifier ?? 'unknown model'})`); });
atem.on('disconnected', () => { connected = false; lastDisconnect = new Date(); log('ATEM disconnected — will keep retrying'); });
atem.on('error', (e: unknown) => log('ATEM error:', e));

async function connectAtem(ip: string) {
  try { await atem.disconnect(); } catch { /* not connected */ }
  connected = false;
  log(`Connecting to ATEM at ${ip}…`);
  atem.connect(ip).catch(e => log('connect failed:', e)); // atem-connection keeps retrying on its own
}

// ------------------------------- logger -------------------------------------
const logger = new EdlLogger();
const updater = new Updater(path.join(__dirname, '..'), log);
let sessionStartedAt: Date | null = null;

// If the app was killed mid-show, tell the operator where the partial EDL is.
let recoveredSession: { edl: string; title: string; startedAt: string } | null = null;
if (existsSync(SESSION_FILE)) {
  try { recoveredSession = JSON.parse(readFileSync(SESSION_FILE, 'utf-8')); } catch { /* ignore */ }
}

function inputName(id: number): string {
  const i = atem.state?.inputs?.[id];
  return i?.longName || i?.shortName || (id ? `Input ${id}` : '');
}

// ----------------------------- Tentacle Sync --------------------------------
// Jams USB-connected Tentacle Sync units to the same timecode the EDL uses
// (the switcher's, or this computer's clock), so camera files conform.

/** Switcher timecode anchored to performance.now(), refreshed every 5 s for the live display. */
let atemClock: AtemAnchor & { df: boolean } | null = null;
atem.on('updatedTime', (t: { hour: number; minute: number; second: number; frame: number; dropFrame?: boolean }) => {
  const fr = frameRateFromVideoMode(atem.state?.settings?.videoMode);
  const df = typeof t.dropFrame === 'boolean' ? t.dropFrame : fr.real % 1 !== 0 && (fr.base === 30 || fr.base === 60);
  atemClock = { frames: tcToFrames(t.hour, t.minute, t.second, t.frame, fr.base, df), ms: performance.now(), df };
});
atem.on('disconnected', () => { atemClock = null; });
setInterval(() => { if (connected) atem.requestTime().catch(() => undefined); }, 5000);

function sourceTimecode(): { timecode: string | null; rate: string; tentacleRate: string } {
  const fr = frameRateFromVideoMode(atem.state?.settings?.videoMode);
  if (settings.tcSource === 'clock') {
    const c = readClockTime(connected ? atem as unknown as AtemLike : null);
    return { timecode: framesToTc(c.anchor.frames, c.fr.base, c.dropFrame), rate: `${c.fr.label}${c.dropFrame ? ' DF' : ''}`, tentacleRate: formatRate(tentacleRateFor(c.fr, c.dropFrame).rate) };
  }
  if (!connected || !atemClock) return { timecode: null, rate: fr.label, tentacleRate: formatRate(tentacleRateFor(fr, false).rate) };
  const now = atemClock.frames + ((performance.now() - atemClock.ms) / 1000) * fr.real;
  return { timecode: framesToTc(now, fr.base, atemClock.df), rate: `${fr.label}${atemClock.df ? ' DF' : ''}`, tentacleRate: formatRate(tentacleRateFor(fr, atemClock.df).rate) };
}

const tentacle = {
  plugged: [] as { key: string; pid: number }[],
  usbError: null as string | null,
  busy: null as 'jam' | 'check' | null,
  reports: [] as DeviceReport[],
  log: [] as { at: string; ok: boolean; text: string }[],
  autoJammed: new Set<string>(),
};

function tentacleNote(ok: boolean, text: string) {
  tentacle.log.unshift({ at: new Date().toLocaleTimeString(), ok, text });
  tentacle.log.length = Math.min(tentacle.log.length, 30);
  log(`Tentacle: ${text}`);
}

function describeReport(r: DeviceReport): string {
  if (r.error) return `${r.device}: ${r.error}`;
  const off = r.offsetFrames === undefined ? '' : r.offsetFrames === 0 ? ', in sync'
    : `, ${Math.abs(r.offsetFrames)} frame${Math.abs(r.offsetFrames) === 1 ? '' : 's'} ${r.offsetFrames > 0 ? 'ahead' : 'behind'}`;
  return `${r.device}: ${r.timecode ?? '?'} @ ${r.frameRate}${off}`;
}

async function jamAll(reason: string): Promise<DeviceReport[]> {
  if (tentacle.busy) throw new Error('Busy — wait for the current jam or check to finish.');
  if (settings.tcSource === 'atem' && !connected) throw new Error(`Not connected to the switcher at ${settings.atemIp}.`);
  tentacle.busy = 'jam';
  try {
    const t = settings.tentacle;
    const r = await jamTentacles(connected ? atem as unknown as AtemLike : null, {
      source: settings.tcSource, setFrameRate: t.setFrameRate, offsetFrames: t.offsetFrames, autoCorrect: t.autoCorrect,
    });
    tentacle.reports = r.reports;
    const from = r.source === 'atem' ? 'switcher' : 'computer clock';
    for (const rep of r.reports) tentacleNote(!rep.error && rep.offsetFrames === 0, `${reason} to ${from} ${r.sourceTimecode} → ${describeReport(rep)}`);
    return r.reports;
  } catch (e: any) {
    tentacleNote(false, `${reason} failed: ${e?.message ?? e}`);
    throw e;
  } finally {
    tentacle.busy = null;
  }
}

async function checkAll(): Promise<DeviceReport[]> {
  if (tentacle.busy) throw new Error('Busy — wait for the current jam or check to finish.');
  tentacle.busy = 'check';
  try {
    const r = await checkTentacles(connected ? atem as unknown as AtemLike : null, settings.tcSource);
    tentacle.reports = r.reports;
    for (const rep of r.reports) tentacleNote(!rep.error && (rep.offsetFrames ?? 0) === 0, `Check → ${describeReport(rep)}`);
    return r.reports;
  } finally {
    tentacle.busy = null;
  }
}

/** Watch USB for Tentacles coming and going; auto-jam each new one. */
setInterval(async () => {
  try {
    tentacle.plugged = await listTentacles();
    tentacle.usbError = null;
  } catch (e: any) {
    tentacle.plugged = [];
    tentacle.usbError = e?.message ?? String(e);
  }
  const keys = new Set(tentacle.plugged.map(p => p.key));
  for (const k of tentacle.autoJammed) if (!keys.has(k)) tentacle.autoJammed.delete(k);
  if (!settings.tentacle.autoJam || tentacle.busy) return;
  if (settings.tcSource === 'atem' && (!connected || !atemClock)) return;
  const fresh = tentacle.plugged.filter(p => !tentacle.autoJammed.has(p.key));
  if (!fresh.length) return;
  fresh.forEach(p => tentacle.autoJammed.add(p.key));
  // Give a just-plugged Tentacle a moment to finish starting up.
  setTimeout(() => { jamAll('Auto-jam').catch(() => undefined); }, 1500);
}, 1000);

// --------------------------------- API --------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) => fn(req, res).catch((e: any) => res.status(400).json({ error: e?.message ?? String(e) }));

app.get('/api/status', (_req, res) => {
  const me = atem.state?.video?.mixEffects?.[settings.me];
  const s = logger.status();
  res.json({
    atem: {
      ip: settings.atemIp, connected,
      model: atem.state?.info?.productIdentifier ?? null,
      connectedSince, lastDisconnect,
      program: me ? { id: me.programInput, name: inputName(me.programInput) } : null,
      preview: me ? { id: me.previewInput, name: inputName(me.previewInput) } : null,
    },
    logging: { ...s, startedAt: sessionStartedAt, recent: logger.active ? logger.recentEvents(12) : [], writeError: logger.lastWriteError },
    recoveredSession,
    export: lastExport,
    platform: settings.platform,
    platformName: PLATFORMS[settings.platform],
    tentacles: {
      plugged: tentacle.plugged.length, usbError: tentacle.usbError, busy: tentacle.busy,
      reports: tentacle.reports, log: tentacle.log, source: settings.tcSource, ...sourceTimecode(),
    },
    host: process.env.HOST_LABEL || os.hostname(),
    version: updater.info.current,
    update: updater.info,
  });
});

app.get('/api/settings', (_req, res) => res.json(settings));

/** Cleans up a folder path typed or pasted into the page, and insists on a full path. */
export function cleanFolderPath(input: string): string {
  let p = input.trim();
  // Surrounding quotes, e.g. from Finder "Copy as Pathname" pasted into a shell, or Windows "Copy as path".
  while (p.length >= 2 && /^['"].*['"]$/.test(p) && p[0] === p[p.length - 1]) p = p.slice(1, -1).trim();
  if (p.startsWith('file://')) p = decodeURIComponent(p.slice(7));
  if (process.platform !== 'win32') p = p.replace(/\\(.)/g, '$1');           // Terminal drag-and-drop escapes ("Project\ 32TB")
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  if (!p) throw new Error('Enter a folder to save EDLs in.');
  if (!path.isAbsolute(p)) throw new Error(`"${input.trim()}" isn't a full folder path. Use one like ${process.platform === 'win32' ? 'D:\\Projects\\Episode_23\\EDL' : '/Volumes/Drive/Episode_23/EDL'}.`);
  return path.normalize(p).replace(/(.)[\\/]+$/, '$1');
}

app.post('/api/settings', wrap(async (req, res) => {
  const b = req.body ?? {};
  const ipChanged = typeof b.atemIp === 'string' && b.atemIp.trim() && b.atemIp.trim() !== settings.atemIp;
  if (ipChanged && logger.active) throw new Error('Stop logging before changing the switcher IP.');
  if (typeof b.outputDir === 'string') settings.outputDir = cleanFolderPath(b.outputDir);
  if (typeof b.mediaDir === 'string') settings.mediaDir = b.mediaDir.trim() ? cleanFolderPath(b.mediaDir) : '';
  if (typeof b.platform === 'string') {
    if (!(b.platform in PLATFORMS)) throw new Error('Unknown edit software.');
    settings.platform = b.platform as Platform;
  }
  for (const k of ['atemIp', 'tcSource', 'recordStartTc', 'lastTitle'] as const) {
    if (typeof b[k] === 'string') (settings as any)[k] = b[k].trim();
  }
  if (typeof b.me === 'number') settings.me = b.me;
  if (b.tentacle && typeof b.tentacle === 'object') {
    const t = b.tentacle;
    for (const k of ['autoJam', 'setFrameRate', 'autoCorrect'] as const) if (typeof t[k] === 'boolean') settings.tentacle[k] = t[k];
    if (t.offsetFrames !== undefined) {
      const n = Number(t.offsetFrames);
      if (!Number.isInteger(n) || Math.abs(n) > 30) throw new Error('Tentacle offset must be a whole number of frames, −30 to 30.');
      settings.tentacle.offsetFrames = n;
    }
    if (t.autoJam === true) tentacle.autoJammed.clear(); // re-arm for Tentacles already plugged in
  }
  if (b.reelNames && typeof b.reelNames === 'object') {
    settings.reelNames = Object.fromEntries(Object.entries(b.reelNames).filter(([, v]) => typeof v === 'string' && (v as string).trim()).map(([k, v]) => [k, (v as string).trim()]));
  }
  saveSettings();
  if (ipChanged) await connectAtem(settings.atemIp);
  res.json(settings);
}));

// Camera inputs, with the reel name each will get in the EDL.
app.get('/api/inputs', (_req, res) => {
  const inputs = atem.state?.inputs ?? {};
  const list = Object.values(inputs as Record<string, any>)
    .filter(i => i && i.inputId > 0 && i.inputId < 1000)
    .map(i => {
      const auto = (i.shortName || `IN${i.inputId}`).toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 8);
      return { id: i.inputId, longName: i.longName, shortName: i.shortName, autoReel: auto, reel: settings.reelNames[String(i.inputId)] ?? '' };
    });
  res.json(list);
});

app.post('/api/start', wrap(async (req, res) => {
  if (!connected) throw new Error(`Not connected to the switcher at ${settings.atemIp}.`);
  const b = req.body ?? {};
  const title = String(b.title ?? settings.lastTitle ?? '').trim();
  if (!title) throw new Error('Enter a show / episode title.');
  if (typeof b.outputDir === 'string' && b.outputDir.trim()) settings.outputDir = cleanFolderPath(b.outputDir);
  settings.outputDir = cleanFolderPath(settings.outputDir);   // also repairs a bad path saved by an older version
  settings.lastTitle = title;
  saveSettings();
  // A drive that isn't mounted would otherwise fail with a confusing permission error.
  const vol = process.platform === 'darwin' && settings.outputDir.match(/^\/Volumes\/[^/]+/)?.[0];
  if (vol && !existsSync(vol)) throw new Error(`The drive "${vol.slice(9)}" isn't connected. Plug it in (or pick another folder) and try again.`);
  const file = await logger.start(atem as unknown as AtemLike, {
    title, me: settings.me, outputDir: settings.outputDir, tcSource: settings.tcSource,
    recordStartTc: settings.recordStartTc, reelNames: settings.reelNames, platform: settings.platform,
  });
  sessionStartedAt = new Date();
  recoveredSession = null;
  writeFileSync(SESSION_FILE, JSON.stringify({ edl: file, title, startedAt: sessionStartedAt }));
  log(`EDL started: ${file}`);
  res.json({ file, status: logger.status() });
}));

app.post('/api/stop', wrap(async (_req, res) => {
  const r = await logger.stop();
  sessionStartedAt = null;
  await fs.rm(SESSION_FILE, { force: true });
  log(`EDL stopped: ${r.events} switches over ${r.length} → ${r.edl}`);
  lastExport = null;
  if (settings.platform === 'fcp') void exportFcpxml(r.edl.replace(/\.edl$/i, '.json'));
  res.json(r);
}));

app.post('/api/marker', wrap(async (req, res) => {
  const note = String(req.body?.note ?? '').trim() || 'Marker';
  const tc = await logger.addMarker(note);
  res.json({ note, timeline: tc });
}));

app.post('/api/tentacle/jam', wrap(async (_req, res) => res.json({ reports: await jamAll('Jam') })));
app.post('/api/tentacle/check', wrap(async (_req, res) => res.json({ reports: await checkAll() })));

app.post('/api/dismiss-recovered', wrap(async (_req, res) => {
  recoveredSession = null;
  await fs.rm(SESSION_FILE, { force: true });
  res.json({ ok: true });
}));

// Updates: check GitHub for a newer release, and install it on request.
app.post('/api/update/check', wrap(async (_req, res) => res.json(await updater.check())));
app.post('/api/update/install', wrap(async (_req, res) => {
  if (logger.active) throw new Error('Stop the EDL before updating — updating restarts the logger.');
  await updater.install();
  res.json(updater.info);
}));

// Service control from this computer only (used by the `atem-logger` command and the tray icon).
const isLocal = (req: express.Request) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
app.post('/api/service/stop', (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Stop the service from the computer it runs on.' });
  res.json({ ok: true, finalized: logger.active });
  void shutdown('Stop requested', 0);
});
app.post('/api/service/restart', (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Restart the service from the computer it runs on.' });
  res.json({ ok: true, finalized: logger.active });
  void shutdown('Restart requested', 75);   // non-zero: the service manager starts it again
});

// ---- Final Cut Pro XML -----------------------------------------------------
let lastExport: { state: 'working' | 'done' | 'failed'; message: string; file?: string; warnings?: string[]; at: Date } | null = null;

/** Builds the .fcpxml for a logged show by finding the camera files (named by reel) and reading their timecode. */
async function exportFcpxml(jsonFile: string, mediaDir?: string) {
  const dir = mediaDir || settings.mediaDir || path.dirname(path.dirname(jsonFile));
  lastExport = { state: 'working', message: `Looking for camera files in ${dir}…`, at: new Date() };
  try {
    const r = await buildFcpxmlFile(jsonFile, dir);
    lastExport = { state: 'done', file: r.file, warnings: r.warnings, at: new Date(),
      message: `Final Cut XML ready: ${path.basename(r.file)} (${r.clips} clips, ${r.markers} markers, from ${Object.keys(r.media).length} camera files).` };
    log(lastExport.message);
  } catch (e: any) {
    lastExport = { state: 'failed', at: new Date(), message: `Final Cut XML not made yet: ${e?.message ?? e}` };
    log(lastExport.message);
  }
  return lastExport;
}

app.post('/api/fcpxml', wrap(async (req, res) => {
  const b = req.body ?? {};
  const mediaDir = typeof b.mediaDir === 'string' && b.mediaDir.trim() ? cleanFolderPath(b.mediaDir) : undefined;
  if (mediaDir) { settings.mediaDir = mediaDir; saveSettings(); }
  let name = typeof b.session === 'string' && b.session ? path.basename(b.session) : '';
  if (!name) {   // newest logged show in the EDL folder
    const jsons = (await fs.readdir(settings.outputDir).catch(() => [] as string[])).filter(n => n.toLowerCase().endsWith('.json'));
    const stats = await Promise.all(jsons.map(async n => ({ n, t: (await fs.stat(path.join(settings.outputDir, n))).mtimeMs })));
    name = stats.sort((x, y) => y.t - x.t)[0]?.n ?? '';
  }
  if (!name) throw new Error('No logged shows in the EDL folder yet.');
  const r = await exportFcpxml(path.join(settings.outputDir, name.replace(/\.(edl|fcpxml)$/i, '.json')), mediaDir);
  if (r?.state === 'failed') return res.status(400).json({ error: r.message });
  res.json(r);
}));

// EDLs in the current output folder, newest first — downloadable from the page
// (handy when the logger runs on another machine than the edit system).
const OUTPUT_EXT = /\.(edl|fcpxml|txt|csv)$/i;
app.get('/api/files', wrap(async (_req, res) => {
  const dir = settings.outputDir;
  let all: string[] = [];
  try { all = await fs.readdir(dir); } catch { return res.json({ dir, files: [], sessions: [], error: 'Folder not found or not reachable' }); }
  const withTime = async (names: string[]) => (await Promise.all(names.map(async n => {
    const st = await fs.stat(path.join(dir, n));
    return { name: n, size: st.size, modified: st.mtime };
  }))).sort((a, b) => +b.modified - +a.modified);
  const files = await withTime(all.filter(n => OUTPUT_EXT.test(n)));
  // Logged shows (their .json journals), for building the Final Cut XML later.
  const sessions = (await withTime(all.filter(n => /\.json$/i.test(n)))).slice(0, 20).map(f => ({ name: f.name, modified: f.modified }));
  res.json({ dir, files: files.slice(0, 40), sessions });
}));

app.get('/api/files/:name', (req, res) => {
  const name = path.basename(req.params.name);
  if (!OUTPUT_EXT.test(name)) return res.status(400).end();
  res.download(path.join(settings.outputDir, name), name, err => { if (err && !res.headersSent) res.status(404).end(); });
});

// ------------------------------ lifecycle -----------------------------------
let shuttingDown = false;
async function shutdown(reason: string, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${reason} — shutting down`);
  if (logger.active) {
    try { const r = await logger.stop(); await fs.rm(SESSION_FILE, { force: true }); log(`EDL finalized on shutdown: ${r.edl}`); } catch (e) { log('finalize failed:', e); }
  }
  atem.disconnect().catch(() => {});
  setTimeout(() => process.exit(code), 300);   // exit code 0 = stopped on purpose (service stays stopped)
}
process.on('SIGINT', () => void shutdown('SIGINT received'));
process.on('SIGTERM', () => void shutdown('SIGTERM received'));

app.listen(PORT, '0.0.0.0', () => {
  log(`ATEM Logger on http://${os.hostname()}:${PORT}  (data: ${DATA_DIR})`);
  void connectAtem(settings.atemIp);
  if (process.env.ATEM_LOGGER_NO_UPDATE_CHECK !== '1') updater.startSchedule();
});
