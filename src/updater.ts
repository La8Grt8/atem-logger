// ---------------------------------------------------------------------------
// Self-update: checks GitHub for a newer version (vX.Y.Z tag) and, when asked, installs it
// in place (git checkout of the release tag, or the release tarball for ZIP
// installs), rebuilds, then exits so the service manager restarts the new
// version. Never runs while an EDL is being logged.
// ---------------------------------------------------------------------------
import { spawn } from 'child_process';
import { existsSync, readFileSync, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO = process.env.UPDATE_REPO ?? 'La8Grt8/atem-logger';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export interface UpdateInfo {
  current: string;
  latest: string | null;
  available: boolean;
  releaseUrl: string | null;
  notes: string | null;
  publishedAt: string | null;
  checkedAt: string | null;
  canUpdate: boolean;
  howTo: string | null;              // shown when the app can't update itself (e.g. Docker)
  state: 'idle' | 'checking' | 'updating' | 'restarting' | 'failed';
  message: string | null;
}

const newer = (a: string, b: string) => {          // is a newer than b?
  const pa = a.split(/[.-]/).map(n => parseInt(n, 10) || 0), pb = b.split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0); }
  return false;
};

export class Updater {
  readonly appDir: string;
  info: UpdateInfo;
  private log: (...a: unknown[]) => void;

  constructor(appDir: string, log: (...a: unknown[]) => void) {
    this.appDir = appDir;
    this.log = log;
    const current = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf-8')).version as string;
    const docker = !!process.env.ATEM_LOGGER_DOCKER;
    this.info = {
      current, latest: null, available: false, releaseUrl: null, notes: null, publishedAt: null, checkedAt: null,
      canUpdate: !docker,
      howTo: docker ? 'Running in Docker: update with  docker compose pull && docker compose up -d' : null,
      state: 'idle', message: null,
    };
  }

  startSchedule() {
    setTimeout(() => void this.check(), 15_000);                  // shortly after start
    setInterval(() => void this.check(), CHECK_EVERY_MS).unref();
  }

  async check(): Promise<UpdateInfo> {
    if (this.info.state === 'updating' || this.info.state === 'restarting') return this.info;
    this.info.state = 'checking';
    try {
      // Versions are the repo's vX.Y.Z tags; a GitHub Release for the tag (optional) supplies the notes.
      const headers = { 'User-Agent': 'atem-logger', Accept: 'application/vnd.github+json' };
      const r = await fetch(`https://api.github.com/repos/${REPO}/tags?per_page=100`, { headers, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
      const tags: string[] = ((await r.json()) as any[]).map(t => String(t.name)).filter(n => /^v?\d+\.\d+\.\d+$/.test(n));
      if (!tags.length) throw new Error('no version tags found');
      const latest = tags.map(t => t.replace(/^v/, '')).reduce((a, b) => (newer(b, a) ? b : a));
      let releaseUrl = `https://github.com/${REPO}/releases/tag/v${latest}`, notes: string | null = null, publishedAt: string | null = null;
      try {
        const rel = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/v${latest}`, { headers, signal: AbortSignal.timeout(10_000) });
        if (rel.ok) { const j: any = await rel.json(); releaseUrl = j.html_url ?? releaseUrl; notes = j.body ?? null; publishedAt = j.published_at ?? null; }
      } catch { /* notes are optional */ }
      Object.assign(this.info, {
        latest, available: newer(latest, this.info.current), releaseUrl, notes, publishedAt,
        checkedAt: new Date().toISOString(), state: 'idle', message: null,
      });
      if (this.info.available) this.log(`Update available: ${this.info.current} → ${latest}`);
    } catch (e: any) {
      Object.assign(this.info, { state: 'idle', checkedAt: new Date().toISOString(), message: `Update check failed: ${e?.message ?? e}` });
    }
    return this.info;
  }

  /** Installs the latest release, rebuilds, then exits with code 75 so launchd / the Windows service restarts it. */
  async install(): Promise<void> {
    if (!this.info.canUpdate) throw new Error(this.info.howTo ?? 'This install can’t update itself.');
    if (this.info.state === 'updating' || this.info.state === 'restarting') throw new Error('An update is already in progress.');
    if (!this.info.available || !this.info.latest) { await this.check(); }
    if (!this.info.available || !this.info.latest) throw new Error('You already have the latest version.');
    const tag = `v${this.info.latest}`;
    this.info.state = 'updating';
    this.info.message = `Downloading ${tag}…`;
    this.log(`Updating to ${tag}`);
    void (async () => {
      try {
        if (existsSync(path.join(this.appDir, '.git'))) {
          await this.run('git', ['fetch', '--tags', '--force', '--quiet', 'origin']);
          await this.run('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', tag]);
        } else {
          await this.fromTarball(tag);
        }
        this.info.message = 'Installing…';
        const npm = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
        await this.run(existsSync(npm) ? npm : 'npm', ['ci', '--include=dev', '--ignore-scripts', '--no-fund', '--no-audit', '--loglevel=error']);
        this.info.message = 'Building…';
        await this.run(existsSync(npm) ? npm : 'npm', ['run', 'build', '--silent']);
        this.info.state = 'restarting';
        this.info.message = `Updated to ${tag} — restarting…`;
        this.log(`Updated to ${tag}; restarting`);
        setTimeout(() => process.exit(75), 1500);   // non-zero exit: service manager starts the new version
      } catch (e: any) {
        this.info.state = 'failed';
        this.info.message = `Update failed: ${e?.message ?? e}`;
        this.log(this.info.message);
      }
    })();
  }

  private async fromTarball(tag: string) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'atem-logger-update-'));
    try {
      const r = await fetch(`https://github.com/${REPO}/archive/refs/tags/${tag}.tar.gz`, { signal: AbortSignal.timeout(120_000) });
      if (!r.ok) throw new Error(`download failed (${r.status})`);
      const tgz = path.join(tmp, 'release.tar.gz');
      await fs.writeFile(tgz, Buffer.from(await r.arrayBuffer()));
      await this.run('tar', ['-xzf', tgz, '-C', tmp]);
      const src = (await fs.readdir(tmp, { withFileTypes: true })).find(d => d.isDirectory())?.name;
      if (!src) throw new Error('release archive was empty');
      const skip = new Set(['node_modules', 'dist', '.git', 'data', 'edl']);
      for (const entry of await fs.readdir(path.join(tmp, src))) {
        if (skip.has(entry)) continue;
        await fs.cp(path.join(tmp, src, entry), path.join(this.appDir, entry), { recursive: true, force: true });
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  private run(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` };
      const p = spawn(cmd, args, { cwd: this.appDir, env, shell: process.platform === 'win32' });
      let err = '';
      p.stdout.on('data', d => this.log(String(d).trim()));
      p.stderr.on('data', d => { err += d; this.log(String(d).trim()); });
      p.on('error', reject);
      p.on('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} ${args[0]} failed: ${err.trim().split('\n').pop() || 'exit ' + code}`)));
    });
  }
}
