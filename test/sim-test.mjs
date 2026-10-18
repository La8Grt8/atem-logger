// Simulated-switcher test: drives the EDL logger with fake ATEM state changes.
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { EdlLogger } from '../dist/edl-logger.js';

const atem = new EventEmitter();
atem.state = {
  settings: { videoMode: undefined },
  inputs: { 1: { longName: '1 - Host', shortName: 'CAM1' }, 2: { longName: '2 - Wide', shortName: 'CAM2' }, 3: { longName: '3 - Guest', shortName: 'CAM3' } },
  video: { mixEffects: [{ programInput: 1, previewInput: 2, transitionPosition: { inTransition: false } }] },
};
atem.requestTime = async () => { atem.emit('updatedTime', { hour: 11, minute: 59, second: 29, frame: 11, dropFrame: true }); };

const cut = (to) => {
  const me = atem.state.video.mixEffects[0];
  me.previewInput = me.programInput; me.programInput = to;
  atem.emit('stateChanged', atem.state, ['video.mixEffects.0.programInput']);
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'edltest-'));
const logger = new EdlLogger();
const file = await logger.start(atem, { title: 'Sim Test', outputDir: dir, reelNames: { 2: 'WIDE' } });
for (const to of [3, 1, 2, 3, 1]) { await wait(400); cut(to); }
await logger.addMarker('Good soundbite');
console.log('recent:', logger.recentEvents(3));
const r = await logger.stop();
console.log('stop:', r);
console.log((await fs.readFile(r.edl, 'utf-8')));
console.log(r.markers ? await fs.readFile(r.markers, 'utf-8') : 'no markers file');
