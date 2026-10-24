// Simulated show logged once per edit platform; prints each platform's files.
// Optional: node test/platforms-test.mjs <camera-folder>  → also builds the FCPXML from that folder.
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { EdlLogger } from '../dist/edl-logger.js';
import { buildFcpxmlFile } from '../dist/fcpxml.js';

const mediaDir = process.argv[2];
const wait = ms => new Promise(r => setTimeout(r, ms));

async function show(platform, dir) {
  const atem = new EventEmitter();
  atem.state = {
    settings: { videoMode: 11 },   // 1080p29.97
    inputs: { 1: { longName: '1 - Host', shortName: 'CAM1' }, 2: { longName: '2 - Wide', shortName: 'CAM2' }, 3: { longName: '3 - Guest', shortName: 'CAM3' } },
    video: { mixEffects: [{ programInput: 1, previewInput: 2, transitionPosition: { inTransition: false } }] },
  };
  atem.requestTime = async () => atem.emit('updatedTime', { hour: 11, minute: 59, second: 30, frame: 0, dropFrame: true });
  const cut = to => { const me = atem.state.video.mixEffects[0]; me.programInput = to; atem.emit('stateChanged', atem.state, ['video.mixEffects.0.programInput']); };
  const logger = new EdlLogger();
  await logger.start(atem, { title: `Platform Test ${platform}`, outputDir: dir, platform });
  for (const [to, ms] of [[3, 900], [2, 700], [1, 600]]) { await wait(ms); cut(to); }
  await logger.addMarker('Great answer, "clip" for social');
  await wait(500); cut(3);
  await wait(400); await logger.addMarker('Retake');
  await wait(600);
  return logger.stop();
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'platforms-'));
const results = await Promise.all(['resolve', 'premiere', 'avid', 'fcp'].map(p => show(p, dir)));
for (const r of results) {
  console.log(`\n===== ${path.basename(r.edl)}`);
  console.log((await fs.readFile(r.edl, 'utf-8')).split('\n').slice(0, 8).join('\n'));
  console.log(`----- ${path.basename(r.markers)}`);
  console.log(await fs.readFile(r.markers, 'utf-8'));
}
if (mediaDir) {
  const json = results[3].edl.replace(/\.edl$/, '.json');
  const r = await buildFcpxmlFile(json, mediaDir);
  console.log('\n===== FCPXML', r.file, `clips=${r.clips} markers=${r.markers}`, r.warnings);
  console.log(await fs.readFile(r.file, 'utf-8'));
}
