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
import { EdlLogger, AtemLike } from './edl-logger.js';

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
}
const defaults: Settings = {
  atemIp: process.env.ATEM_IP ?? '192.168.11.240',
  outputDir: process.env.OUTPUT_DIR ?? path.join(os.homedir(), process.platform === 'win32' ? 'Videos' : 'Movies', 'ATEM EDLs'),
  me: 0,
  tcSource: 'atem',
  recordStartTc: '01:00:00:00',
  reelNames: {},
  lastTitle: '',
};
function loadSettings(): Settings {
  try { return { ...defaults, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')) }; } catch { return { ...defaults }; }
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
    host: process.env.HOST_LABEL || os.hostname(),
  });
});

app.get('/api/settings', (_req, res) => res.json(settings));

app.post('/api/settings', wrap(async (req, res) => {
  const b = req.body ?? {};
  const ipChanged = typeof b.atemIp === 'string' && b.atemIp.trim() && b.atemIp.trim() !== settings.atemIp;
  if (ipChanged && logger.active) throw new Error('Stop logging before changing the switcher IP.');
  for (const k of ['atemIp', 'outputDir', 'tcSource', 'recordStartTc', 'lastTitle'] as const) {
    if (typeof b[k] === 'string') (settings as any)[k] = b[k].trim();
  }
  if (typeof b.me === 'number') settings.me = b.me;
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
  if (typeof b.outputDir === 'string' && b.outputDir.trim()) settings.outputDir = b.outputDir.trim();
  settings.lastTitle = title;
  saveSettings();
  const file = await logger.start(atem as unknown as AtemLike, {
    title, me: settings.me, outputDir: settings.outputDir, tcSource: settings.tcSource,
    recordStartTc: settings.recordStartTc, reelNames: settings.reelNames,
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
  res.json(r);
}));

app.post('/api/marker', wrap(async (req, res) => {
  const note = String(req.body?.note ?? '').trim() || 'Marker';
  const tc = await logger.addMarker(note);
  res.json({ note, timeline: tc });
}));

app.post('/api/dismiss-recovered', wrap(async (_req, res) => {
  recoveredSession = null;
  await fs.rm(SESSION_FILE, { force: true });
  res.json({ ok: true });
}));

// EDLs in the current output folder, newest first — downloadable from the page
// (handy when the logger runs on another machine than the edit system).
app.get('/api/files', wrap(async (_req, res) => {
  const dir = settings.outputDir;
  let names: string[] = [];
  try { names = (await fs.readdir(dir)).filter(n => n.toLowerCase().endsWith('.edl')); } catch { return res.json({ dir, files: [], error: 'Folder not found or not reachable' }); }
  const files = await Promise.all(names.map(async n => {
    const st = await fs.stat(path.join(dir, n));
    return { name: n, size: st.size, modified: st.mtime };
  }));
  files.sort((a, b) => +b.modified - +a.modified);
  res.json({ dir, files: files.slice(0, 30) });
}));

app.get('/api/files/:name', (req, res) => {
  const name = path.basename(req.params.name);
  if (!name.toLowerCase().endsWith('.edl')) return res.status(400).end();
  res.download(path.join(settings.outputDir, name), name, err => { if (err && !res.headersSent) res.status(404).end(); });
});

// ------------------------------ lifecycle -----------------------------------
async function shutdown(sig: string) {
  log(`${sig} received`);
  if (logger.active) {
    try { const r = await logger.stop(); await fs.rm(SESSION_FILE, { force: true }); log(`EDL finalized on shutdown: ${r.edl}`); } catch (e) { log('finalize failed:', e); }
  }
  try { await atem.disconnect(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

app.listen(PORT, '0.0.0.0', () => {
  log(`ATEM Logger on http://${os.hostname()}:${PORT}  (data: ${DATA_DIR})`);
  void connectAtem(settings.atemIp);
});
