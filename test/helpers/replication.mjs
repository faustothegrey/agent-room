// B0 scenario adapter: production storage and HTTP handler, with fixed test identities.
import * as R from '../../src/replicate.mjs';
import fs from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
export * from '../../src/replicate.mjs';
export const gitUsed = new Set();
export async function openNode(dir, { room, node, peers = [] }) {
  if (dir.endsWith('/.agent-room')) dir = dir.slice(0, -12);
  const s = await R.openStore(dir, node);
  await fs.writeFile(join(s.dir, 'room.json'), JSON.stringify({roomId: room, paired: Object.fromEntries(peers.map(p => [p,{roomId:room}]))}));
  s.testRoom = room; s.testPeers = peers;
  return s;
}
export async function capture(s, d, dir, { round, outcome = 'completed', parent } = {}) {
  if (parent) await R.git(s.store, ['update-ref', R.lineRef(d,s.node), parent]);
  await fs.writeFile(join(s.dir,'discussions.json'), JSON.stringify({'2026-11-07-test':d}));
  const c = await R.capture(s, {name:'2026-11-07-test',dir,title:'Test'}, {kind:'round',outcome,ending:'test',summary:null,agents:[],conversation:[]});
  return c.commit;
}
export async function readPointer(s,d,n) {
  const p = await R.readPointer(s,d,n);
  return p && {...p, history:(await R.git(s.store,['rev-list','--reverse',p.commit])).split('\n')};
}
export async function snapshotDir(s,d,n) { return R.snapshotPath(s,d,n,(await R.readPointer(s,d,n)).commit); }
export async function serve(s,{limits=R.LIMITS}={}) {
  for(const l of await R.receivedLines(s)) await R.pin(s,l.board,l.node);
  let pending = Promise.resolve();
  const r = {s, peers:s.testPeers.map(name=>({name})),limits, activity:()=> 'idle'};
  const server = http.createServer((req,res) => {
    pending = R.handle(r,req,res).then(async () => {
      // B0 inspected every older snapshot. Pin them in this scenario; production retains latest + pins.
      for(const l of await R.receivedLines(s)) if(!s.pins.has(`${l.board}/${l.node}/${l.commit}`)) await R.pin(s,l.board,l.node);
    });
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  return {url:`http://127.0.0.1:${server.address().port}`, close:(cb)=>server.close(cb), settled:()=>pending,
    set dropReplyOnce(v){r.dropReplyOnce=v;} };
}
