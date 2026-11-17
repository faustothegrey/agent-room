import { test } from './helpers/test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as ui from '../src/ui.mjs';
import * as R from '../src/replicate.mjs';
import { createRoom } from '../src/room.mjs';

const wait = async (fn) => { for (let i=0;i<100;i++) { if (await fn()) return; await new Promise(r=>setTimeout(r,50)); } throw new Error('Timed out'); };

test('closed discussion lifecycle publishes only on Close', { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'closed-cycle-')), rooms = [];
  const make = async (node) => {
    const cwd = join(root, node); await fs.mkdir(cwd);
    const ctx = { cwd, node, peers: [], port: 0, noScreen: true, hub: { rooms: new Map(), node },
      agentSpecs: 'claude:A', workerSpec: 'claude:W', sessions: new Map(), state: { transcript: [], seen: new Map() } };
    Object.assign(ctx, await ui.load(ctx, ''));
    // Close's writer, in place of a real CLI: it answers as the room's agent is scripted to.
    ctx.closingAgent = () => ({ name: 'W', turn: (p) => ctx.room.agents.at(-1).turn(p) });
    ctx.hub.rooms.set(ctx.key, ctx);
    ctx.usage = { ...ctx.usage, fetchQuota: async () => null };
    ctx.suggestTitle = async () => ({ title: 'Closed cycle' });
    await ui.start(ctx); rooms.push(ctx);
    ctx.origin = `http://127.0.0.1:${ctx.server.address().port}`;
    return ctx;
  };
  try {
    const a = await make('Mac'), b = await make('Pi');
    a.peers.push({ name: 'Pi', url: b.origin }); b.peers.push({ name: 'Mac', url: a.origin });
    await R.pair(a.replica, 'Pi');
    Object.assign(a.sessions.get('A'), { id: 'old-agent', started: true });
    Object.assign(a.sessions.get('worker:W'), { id: 'old-worker', started: true });
    a.room.agents[0].turn = async (p) => p.includes('The User is closing this discussion.') ? 'Closing statement; pending-instructions.md' : p.includes('User asked for a summary') ? 'An agreed summary' : 'PASS';
    await ui.handleLine('first round', a);
    await ui.handleLine('/summary', a);
    const name = a.discussion.name, dir = a.discussion.dir;
    assert.deepEqual(await R.ownLines(a.replica.s), {});
    assert.deepEqual(await R.receivedLines(b.replica.s), []);
    await ui.handleLine('/close', a);
    assert.match(await fs.readFile(join(dir, 'closing-statement.md'), 'utf8'), /pending-instructions\.md/);
    assert.ok(a.screen.room.closedDiscussions.includes(name));
    assert.notEqual(a.sessions.get('A').id, 'old-agent');
    assert.notEqual(a.sessions.get('worker:W').id, 'old-worker');
    await wait(async () => (await R.receivedLines(b.replica.s)).length === 1);
    const [line] = await R.receivedLines(b.replica.s);
    const old = await R.readPointer(b.replica.s, line.discussion, 'Mac');
    await ui.handleLine(`/move ${name} archive`, a);
    await ui.handleLine(`/move archive/${name} active`, a);
    assert.ok(a.screen.room.closedDiscussions.includes(name));
    await ui.handleLine(`/resume ${name}`, a);
    assert.ok(!a.screen.room.closedDiscussions.includes(name));
    assert.notEqual(a.sessions.get('A').id, 'old-agent');
    assert.notEqual(a.sessions.get('worker:W').id, 'old-worker');
    const prompts = [];
    a.room.agents[0].turn = async (p) => { prompts.push(p); return p.includes('The User is closing this discussion.') ? 'Updated statement; pending-instructions.md' : 'PASS'; };
    await ui.handleLine('after reopening', a);
    assert.match(prompts[0], /Closing statement; pending-instructions\.md/);
    await fs.writeFile(join(a.discussion.dir, 'after-reopen.md'), 'not yet replicated');
    await R.kick(a.replica, 'Pi');
    assert.equal((await R.readPointer(b.replica.s, line.discussion, 'Mac')).commit, old.commit);
    await ui.handleLine('/close', a);
    await wait(async () => (await R.readPointer(b.replica.s, line.discussion, 'Mac')).round === old.round + 1);
    const latest = await R.readPointer(b.replica.s, line.discussion, 'Mac');
    assert.ok(R.snapshotFile(b.replica.s, line.discussion, 'Mac', latest.commit, 'after-reopen.md'));
  } finally {
    for (const c of rooms) { ui.ended(c); clearInterval(c.quotaTimer); await new Promise((r) => c.server.close(r)); }
    await R.removeTree(root);
  }
});
test('replication startup publishes a closed snapshot interrupted before its line update', { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'interrupted-close-')), rooms = [];
  const make = async (node, peers = []) => {
    const cwd = join(root, node); await fs.mkdir(cwd, { recursive: true });
    const ctx = { cwd, node, peers, port: 0, noScreen: true, hub: { rooms: new Map(), node },
      agentSpecs: 'claude:A', workerSpec: 'claude:W', sessions: new Map(), state: { transcript: [], seen: new Map() } };
    Object.assign(ctx, await ui.load(ctx, ''));
    // Close's writer, in place of a real CLI: it answers as the room's agent is scripted to.
    ctx.closingAgent = () => ({ name: 'W', turn: (p) => ctx.room.agents.at(-1).turn(p) }); ctx.hub.rooms.set(ctx.key, ctx);
    ctx.usage = { ...ctx.usage, fetchQuota: async () => null };
    ctx.suggestTitle = async () => ({ title: 'Interrupted close' });
    await ui.start(ctx); rooms.push(ctx);
    ctx.origin = `http://127.0.0.1:${ctx.server.address().port}`;
    return ctx;
  };
  try {
    const a = await make('Mac'), b = await make('Pi');
    a.peers.push({ name: 'Pi', url: b.origin }); b.peers.push({ name: 'Mac', url: a.origin });
    await R.pair(a.replica, 'Pi');
    a.room.agents[0].turn = async (p) => p.includes('The User is closing this discussion.') ? 'Statement: pending-instructions.md' : 'PASS';
    await ui.handleLine('first', a);
    const { name } = a.discussion;
    let marked;
    const stopped = new Promise((resolve) => { marked = resolve; });
    a.replicate = { ...a.replicate, publishCapture: async (_store, snapshot) => { marked(snapshot); await new Promise(() => {}); } };
    void ui.handleLine('/close', a);
    const snapshot = await stopped;
    assert.deepEqual(await R.ownLines(a.replica.s), {});
    assert.deepEqual(await R.receivedLines(b.replica.s), []);
    ui.ended(a); clearInterval(a.quotaTimer); await new Promise((resolve) => a.server.close(resolve));
    rooms.splice(rooms.indexOf(a), 1);
    const restarted = await make('Mac', [{ name: 'Pi', url: b.origin }]);
    assert.ok(restarted.screen.room.closedDiscussions.includes(name));
    assert.equal((await R.ownLines(restarted.replica.s))[snapshot.discussion].commit, snapshot.commit);
    await wait(async () => (await R.receivedLines(b.replica.s)).length === 1);
    const peer = await R.readPointer(b.replica.s, snapshot.discussion, 'Mac');
    assert.equal(peer.commit, snapshot.commit);
  } finally {
    for (const c of rooms) { ui.ended(c); clearInterval(c.quotaTimer); await new Promise((resolve) => c.server.close(resolve)); }
    await R.removeTree(root);
  }
});

test('failed Close captures cannot reach peers, including after restart and retry', { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'failed-close-')), rooms = [];
  const make = async (node) => {
    const cwd = join(root, node); await fs.mkdir(cwd);
    const ctx = { cwd, node, peers: [], port: 0, noScreen: true, hub: { rooms: new Map(), node },
      agentSpecs: 'claude:A', workerSpec: 'claude:W', sessions: new Map(), state: { transcript: [], seen: new Map() } };
    Object.assign(ctx, await ui.load(ctx, ''));
    // Close's writer, in place of a real CLI: it answers as the room's agent is scripted to.
    ctx.closingAgent = () => ({ name: 'W', turn: (p) => ctx.room.agents.at(-1).turn(p) }); ctx.hub.rooms.set(ctx.key, ctx);
    ctx.usage = { ...ctx.usage, fetchQuota: async () => null };
    ctx.suggestTitle = async () => ({ title: 'Failed capture' });
    await ui.start(ctx); rooms.push(ctx);
    ctx.origin = `http://127.0.0.1:${ctx.server.address().port}`;
    return ctx;
  };
  try {
    const a = await make('Mac'), b = await make('Pi');
    a.peers.push({ name: 'Pi', url: b.origin }); b.peers.push({ name: 'Mac', url: a.origin });
    await R.pair(a.replica, 'Pi');
    const script = () => { a.room.agents[0].turn = async (p) => p.includes('The User is closing this discussion.') ? 'Statement: pending-instructions.md' : 'PASS'; };
    script(); await ui.handleLine('first', a);
    const { name, dir } = a.discussion;
    await ui.handleLine('/close', a);
    await wait(async () => (await R.receivedLines(b.replica.s)).length === 1);
    const [line] = await R.receivedLines(b.replica.s);
    const previous = await R.readPointer(b.replica.s, line.discussion, 'Mac');
    await ui.handleLine(`/resume ${name}`, a); script();
    await fs.writeFile(join(dir, 'failed-only.md'), 'must not be published');
    const notes = [], broadcast = a.docs.broadcast;
    a.docs = { ...a.docs, broadcast: (screen, event) => { if (event.type === 'note') notes.push(event.text); broadcast(screen, event); } };
    const real = a.replicate;
    a.replicate = { ...real, capture: async () => { throw new Error('capture failed'); } };
    await ui.handleLine('/close', a);
    assert.equal(a.discussion.name, name);
    assert.ok(!a.screen.room.closedDiscussions.includes(name));
    assert.ok(notes.some((text) => text.includes('capture failed')));
    a.replicate = { ...real, publishCapture: async (...args) => { await real.publishCapture(...args); throw new Error('publish failed'); } };
    await ui.handleLine('/close', a);
    assert.equal(a.discussion.name, name);
    assert.ok(!a.screen.room.closedDiscussions.includes(name));
    assert.equal((await R.ownLines(a.replica.s))[line.discussion].commit, previous.commit);
    const reopenedStore = await R.openStore(a.cwd, 'Mac');
    assert.equal((await R.ownLines(reopenedStore))[line.discussion].commit, previous.commit);
    await R.kick(a.replica, 'Pi');
    assert.equal((await R.readPointer(b.replica.s, line.discussion, 'Mac')).commit, previous.commit);
    await fs.unlink(join(dir, 'failed-only.md'));
    a.replicate = real;
    await ui.handleLine('/close', a);
    assert.ok(a.screen.room.closedDiscussions.includes(name));
    await wait(async () => (await R.readPointer(b.replica.s, line.discussion, 'Mac')).round === previous.round + 1);
    const latest = await R.readPointer(b.replica.s, line.discussion, 'Mac');
    assert.equal(R.snapshotFile(b.replica.s, line.discussion, 'Mac', latest.commit, 'failed-only.md'), null);
  } finally {
    for (const c of rooms) { ui.ended(c); clearInterval(c.quotaTimer); await new Promise((r) => c.server.close(r)); }
    await R.removeTree(root);
  }
});

test('two rooms: pairing, round hooks, independent browser pins, deletion and read-only guards', async () => {
  const root = await fs.mkdtemp(join(tmpdir(),'replication-ui-')), rooms=[];
  const make = async (node) => {
    const cwd = join(root,node); await fs.mkdir(cwd);
    // Each node is a server with this room as its launch room, as cli.mjs sets it up.
    const hub = {rooms:new Map(),node};
    const ctx = {cwd,node,peers:[],port:0,hub,launch:true,agentSpecs:'claude:A',workerSpec:'claude:W',sessions:new Map(),state:{transcript:[],seen:new Map()},say:()=>{throw new Error('View started agents');}};
    Object.assign(ctx, await ui.load(ctx, ''));
    // Close's writer, in place of a real CLI: it answers as the room's agent is scripted to.
    ctx.closingAgent = () => ({ name: 'W', turn: (p) => ctx.room.agents.at(-1).turn(p) });
    hub.rooms.set(ctx.key, ctx);
    ctx.usage={...ctx.usage,fetchQuota:async()=>null};
    ctx.room=createRoom([{name:'A',provider:'claude',turn:async(p)=>p.includes('The User is closing this discussion.') ? 'Statement: pending-instructions.md' : 'PASS'}],ctx.state);
    ctx.suggestTitle=async()=>({title:'Replication test'});
    await ui.start(ctx); rooms.push(ctx);
    assert.deepEqual(ctx.screen.replica.project, ctx.project);
    // Peers reach the server (its launch room's /replica/…); the page reaches the room at its address.
    ctx.origin=`http://127.0.0.1:${ctx.server.address().port}`;
    ctx.base=`${ctx.origin}/r/${ctx.id}`;
    return ctx;
  };
  try {
    const a=await make('Mac'), b=await make('Pi');
    a.peers.push({name:'Pi',url:b.origin}); b.peers.push({name:'Mac',url:a.origin});
    const post=async(c,path,body,client='browser-one')=>fetch(c.base+path,{method:'POST',headers:{'content-type':'application/json','x-view-client':client},body:JSON.stringify(body)});
    const preview=await (await post(a,'/__pair',{peer:'Pi'})).json();
    assert.equal(preview.peer.root,b.cwd); assert.equal(preview.local.root,a.cwd); assert.equal(preview.peer.project.commit,null);
    assert.equal((await post(a,'/__pair',{peer:'Pi',confirm:true})).status,200);
    await ui.handleLine('first round',a);
    const name=a.discussion.name, dir=a.discussion.dir;
    assert.deepEqual(await R.receivedLines(b.replica.s),[]);
    await ui.handleLine('/close',a);
    await wait(async()=> (await R.receivedLines(b.replica.s)).length===1);
    const [line]=await R.receivedLines(b.replica.s);
    assert.ok((await fs.readdir(R.snapshotPath(b.replica.s,line.discussion,'Mac',line.commit))).includes('transcripts'));
    const view=async(client)=> (await post(b,'/__view',{discussion:line.discussion,node:'Mac'},client)).json();
    const v1=await view('browser-one'),v2=await view('browser-two');
    assert.equal(v1.viewing.commit,line.commit); assert.equal(v2.viewing.commit,line.commit);
    assert.equal((await post(b,'/__say',{text:'must refuse'})).status,409);
    await ui.handleLine('/resume '+name,a);
    a.room.agents[0].turn=async(p)=>p.includes('The User is closing this discussion.') ? 'Statement: pending-instructions.md' : 'PASS';
    await fs.writeFile(join(dir,'drawing.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
    await ui.handleLine('second round',a);
    assert.equal((await R.readPointer(b.replica.s,line.discussion,'Mac')).commit,line.commit);
    await ui.handleLine('/close',a);
    await wait(async()=> (await R.readPointer(b.replica.s,line.discussion,'Mac')).round===2);
    const latest=await R.readPointer(b.replica.s,line.discussion,'Mac');
    assert.ok(R.snapshotFile(b.replica.s,line.discussion,'Mac',line.commit,'transcripts/'+(await fs.readdir(join(R.snapshotPath(b.replica.s,line.discussion,'Mac',line.commit),'transcripts')))[0]));
    await post(b,'/__view',{back:true},'browser-one');
    assert.ok(await fs.stat(R.snapshotPath(b.replica.s,line.discussion,'Mac',line.commit)));
    await post(b,'/__view',{back:true},'browser-two');
    await assert.rejects(fs.stat(R.snapshotPath(b.replica.s,line.discussion,'Mac',line.commit)),{code:'ENOENT'});
    await ui.handleLine('/resume '+name,a);
    a.room.agents[0].turn=async(p)=>p.includes('The User is closing this discussion.') ? 'Statement: pending-instructions.md' : 'PASS';
    await fs.rm(join(dir,'drawing.svg'));
    await ui.handleLine('third round',a);
    assert.equal((await R.readPointer(b.replica.s,line.discussion,'Mac')).commit,latest.commit);
    await ui.handleLine('/close',a);
    await wait(async()=> (await R.readPointer(b.replica.s,line.discussion,'Mac')).round===3);
    const third=await R.readPointer(b.replica.s,line.discussion,'Mac');
    assert.equal(R.snapshotFile(b.replica.s,line.discussion,'Mac',third.commit,'drawing.svg'),null);
    await wait(async()=> !(await fs.stat(R.snapshotPath(b.replica.s,line.discussion,'Mac',latest.commit)).catch(()=>null)));
    await assert.rejects(fs.stat(R.snapshotPath(b.replica.s,line.discussion,'Mac',latest.commit)),{code:'ENOENT'});
    await ui.handleLine('/resume '+name,a);
    a.room = createRoom([{name:'A',provider:'claude',turn:async()=>{throw new Error('provider failed');}}],a.state);
    await ui.handleLine('failed round',a);
    let own=(await R.ownLines(a.replica.s))[line.discussion];
    assert.equal(own.commit,third.commit);
    const replies=['an idea','PASS',new Error('summary failed')];
    a.room=createRoom([{name:'A',provider:'claude',turn:async()=>{const r=replies.shift();if(r instanceof Error)throw r;return r??'PASS';}}],a.state);
    await ui.handleLine('failed auto summary',a);
    own=(await R.ownLines(a.replica.s))[line.discussion];
    assert.equal(own.commit,third.commit);
    // A receiver restored with a different room identity refuses pairing and preserves both IDs.
    const before=await R.roomInfo(a.replica.s);
    await fs.writeFile(join(b.replica.s.dir,'room.json'),JSON.stringify({roomId:'another-room',paired:{}}));
    assert.equal((await post(a,'/__pair',{peer:'Pi',confirm:true})).status,400);
    assert.deepEqual(await R.roomInfo(a.replica.s),before);
    assert.equal((await R.roomInfo(b.replica.s)).roomId,'another-room');
  } finally {
    for(const c of rooms) { ui.ended(c); clearInterval(c.quotaTimer); for(const v of c.viewPins?.values()??[]) clearTimeout(v.timer); await new Promise(r=>c.server.close(r)); }
    await R.removeTree(root);
  }
});

// The launch room's other open discussions (contexts that cli.mjs adds with a `context` tag) use its
// one replica: each sends a closed snapshot, and closing one doesn't stop the peers.
test('every closed discussion of a --node launch room replicates, through the launch room\'s replica', async () => {
  const root = await fs.mkdtemp(join(tmpdir(),'replication-ctx-')), rooms=[];
  const room = async (fields) => {
    const ctx = {port:0,agentSpecs:'claude:A',workerSpec:'claude:W',sessions:new Map(),state:{transcript:[],seen:new Map()},say:()=>{},...fields};
    Object.assign(ctx, await ui.load(ctx, ''));
    // Close's writer, in place of a real CLI: it answers as the room's agent is scripted to.
    ctx.closingAgent = () => ({ name: 'W', turn: (p) => ctx.room.agents.at(-1).turn(p) });
    ctx.hub.rooms.set(ctx.key, ctx);
    ctx.usage={...ctx.usage,fetchQuota:async()=>null};
    ctx.room=createRoom([{name:'A',provider:'claude',turn:async(p)=>p.includes('The User is closing this discussion.') ? 'Statement: pending-instructions.md' : 'PASS'}],ctx.state);
    await ui.start(ctx); rooms.push(ctx);
    return ctx;
  };
  const node = async (name) => { const cwd = join(root,name); await fs.mkdir(cwd); const c = await room({cwd,node:name,peers:[],hub:{rooms:new Map(),node:name},launch:true});
    c.suggestTitle=async()=>({title:'First topic'}); c.origin=`http://127.0.0.1:${c.server.address().port}`; c.base=`${c.origin}/r/${c.id}`; return c; };
  try {
    const a=await node('Mac'), b=await node('Pi');
    a.peers.push({name:'Pi',url:b.origin}); b.peers.push({name:'Mac',url:a.origin});
    const post=(path,body)=>fetch(a.base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await post('/__pair',{peer:'Pi',confirm:true})).status,200);
    await ui.handleLine('a round in the first discussion',a);
    const name=a.discussion.name;
    assert.deepEqual(await R.receivedLines(b.replica.s),[]);
    await ui.handleLine('/close',a);
    await wait(async()=> (await R.receivedLines(b.replica.s)).length===1);
    // A second open discussion in Mac's launch folder, as New discussion makes it.
    const second = await room({cwd:a.cwd,key:`${a.key}#d1`,context:'d1',hub:a.hub,launch:false});
    second.suggestTitle=async()=>({title:'Second topic'});
    assert.deepEqual([second.node, second.replica, second.screen.replicaOff], ['Mac', a.replica, null]);
    await ui.handleLine('a round in the second discussion',second);
    assert.equal((await R.receivedLines(b.replica.s)).length,1);
    await ui.handleLine('/close',second);
    await wait(async()=> (await R.receivedLines(b.replica.s)).length===2);
    const titles=(await R.receivedLines(b.replica.s)).map((l)=>l.title).sort();
    assert.deepEqual(titles,['First topic','Second topic']);
    // Closing the second one leaves the replication running for the first.
    ui.ended(second); clearInterval(second.quotaTimer);
    assert.notEqual(a.replica.state.stopped,true);
    await ui.handleLine('/resume '+name,a);
    a.room.agents[0].turn=async(p)=>p.includes('The User is closing this discussion.') ? 'Statement: pending-instructions.md' : 'PASS';
    await ui.handleLine('another round in the first',a);
    const first=(await R.receivedLines(b.replica.s)).find((l)=>l.title==='First topic');
    assert.equal((await R.readPointer(b.replica.s,first.discussion,'Mac')).round,1);
    await ui.handleLine('/close',a);
    await wait(async()=> (await R.readPointer(b.replica.s,first.discussion,'Mac')).round===2);
  } finally {
    for(const c of rooms) { if (c.context) continue; ui.ended(c); clearInterval(c.quotaTimer); await new Promise(r=>c.server.close(r)); }
  }
});

test('storage ignores project filters/transcripts rules, preserves Git state and stable identity', async () => {
  const { execFileSync } = await import('node:child_process');
  const root=await fs.mkdtemp(join(tmpdir(),'replication-project-'));
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
  try {
    git('init','-q'); await fs.writeFile(join(root,'.gitignore'),'transcripts/\n');
    await fs.writeFile(join(root,'source.txt'),'source'); git('add','.');
    git('-c','user.name=test','-c','user.email=test@test','commit','-qm','fixture');
    await fs.writeFile(join(root,'source.txt'),'unstaged source');
    const before=[git('rev-parse','HEAD'),git('status','--porcelain'),git('ls-files','--stage')];
    const s=await R.openStore(root,'Mac');
    const name='2026-11-07-test',dir=join(root,'discussions',name);
    await fs.mkdir(join(dir,'transcripts'),{recursive:true}); await fs.writeFile(join(dir,'transcripts','session.md'),'history');
    git('add','discussions'); // ignored transcript leaves source/index untouched
    const c=await R.capture(s,{name,dir,title:'Test'},{kind:'round',outcome:'interrupted',ending:'test interruption',summary:null,agents:[],conversation:[]});
    assert.equal(await R.discussionId(s,'archive/'+name),c.discussion);
    assert.ok((await R.listTree(s.store,c.commit)).some(e=>e.path==='transcripts/session.md'));
    assert.deepEqual([git('rev-parse','HEAD'),git('status','--porcelain'),git('ls-files','--stage')],before);
    await assert.rejects(R.openStore(root,'AnotherNode'),/belongs to node Mac/);
    const ctx={cwd:root,agentSpecs:'claude:A',workerSpec:'claude:W',sessions:new Map(),state:{transcript:[],seen:new Map()}};
    assert.equal((await ui.load(ctx,'')).replicate,null);
  } finally { await R.removeTree(root); }
});

test('concurrent bootstrap pairings cannot replace an established room identity', async () => {
  const { createServer } = await import('node:http');
  const root=await fs.mkdtemp(join(tmpdir(),'pairing-race-'));
  const r=await R.createReplica({root,node:'Pi',peers:[{name:'Mac',url:'http://127.0.0.1:1'},{name:'Other',url:'http://127.0.0.1:2'}],state:{},activity:()=> 'idle'});
  const server=createServer((req,res)=>R.handle(r,req,res));await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  try {
    const pair=(node,roomId)=>fetch(`http://127.0.0.1:${server.address().port}/replica/pair`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({protocol:1,node,roomId})});
    const res=await Promise.all([pair('Mac','room-one'),pair('Other','room-two')]);
    assert.deepEqual(res.map(r=>r.status).sort(),[200,409]);
    const info=await R.roomInfo(r.s);assert.equal(Object.keys(info.paired).length,1);
    const loser=info.roomId==='room-one'?['Other','room-two']:['Mac','room-one'];
    assert.equal((await pair(...loser)).status,409);assert.deepEqual(await R.roomInfo(r.s),info);
  } finally { await new Promise(ok=>server.close(ok)); await R.removeTree(root); }
});
