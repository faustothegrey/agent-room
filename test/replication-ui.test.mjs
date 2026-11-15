import { test } from './helpers/test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as ui from '../src/ui.mjs';
import * as R from '../src/replicate.mjs';
import { createRoom } from '../src/room.mjs';

const wait = async (fn) => { for (let i=0;i<100;i++) { if (await fn()) return; await new Promise(r=>setTimeout(r,50)); } throw new Error('Timed out'); };
test('two rooms: pairing, round hooks, independent browser pins, deletion and read-only guards', async () => {
  const root = await fs.mkdtemp(join(tmpdir(),'replication-ui-')), rooms=[];
  const make = async (node) => {
    const cwd = join(root,node); await fs.mkdir(cwd);
    // Each node is a server with this room as its launch room, as cli.mjs sets it up.
    const hub = {rooms:new Map(),node};
    const ctx = {cwd,node,peers:[],port:0,hub,launch:true,agentSpecs:'claude:A',workerSpec:'claude:W',sessions:new Map(),state:{transcript:[],seen:new Map()},say:()=>{throw new Error('View started agents');}};
    Object.assign(ctx, await ui.load(ctx, ''));
    hub.rooms.set(ctx.key, ctx);
    ctx.usage={...ctx.usage,fetchQuota:async()=>null};
    ctx.room=createRoom([{name:'A',provider:'claude',turn:async()=> 'PASS'}],ctx.state);
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
    await wait(async()=> (await R.receivedLines(b.replica.s)).length===1);
    const [line]=await R.receivedLines(b.replica.s);
    assert.ok((await fs.readdir(R.snapshotPath(b.replica.s,line.discussion,'Mac',line.commit))).includes('transcripts'));
    const view=async(client)=> (await post(b,'/__view',{discussion:line.discussion,node:'Mac'},client)).json();
    const v1=await view('browser-one'),v2=await view('browser-two');
    assert.equal(v1.viewing.commit,line.commit); assert.equal(v2.viewing.commit,line.commit);
    assert.equal((await post(b,'/__say',{text:'must refuse'})).status,409);
    await fs.writeFile(join(a.discussion.dir,'drawing.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
    await ui.handleLine('second round',a);
    await wait(async()=> (await R.readPointer(b.replica.s,line.discussion,'Mac')).round===2);
    const latest=await R.readPointer(b.replica.s,line.discussion,'Mac');
    assert.ok(R.snapshotFile(b.replica.s,line.discussion,'Mac',line.commit,'transcripts/'+(await fs.readdir(join(R.snapshotPath(b.replica.s,line.discussion,'Mac',line.commit),'transcripts')))[0]));
    await post(b,'/__view',{back:true},'browser-one');
    assert.ok(await fs.stat(R.snapshotPath(b.replica.s,line.discussion,'Mac',line.commit)));
    await post(b,'/__view',{back:true},'browser-two');
    await assert.rejects(fs.stat(R.snapshotPath(b.replica.s,line.discussion,'Mac',line.commit)),{code:'ENOENT'});
    await fs.rm(join(a.discussion.dir,'drawing.svg'));
    await ui.handleLine('third round',a);
    await wait(async()=> (await R.readPointer(b.replica.s,line.discussion,'Mac')).round===3);
    const third=await R.readPointer(b.replica.s,line.discussion,'Mac');
    assert.equal(R.snapshotFile(b.replica.s,line.discussion,'Mac',third.commit,'drawing.svg'),null);
    await wait(async()=> !(await fs.stat(R.snapshotPath(b.replica.s,line.discussion,'Mac',latest.commit)).catch(()=>null)));
    await assert.rejects(fs.stat(R.snapshotPath(b.replica.s,line.discussion,'Mac',latest.commit)),{code:'ENOENT'});
    a.room = createRoom([{name:'A',provider:'claude',turn:async()=>{throw new Error('provider failed');}}],a.state);
    await ui.handleLine('failed round',a);
    let own=(await R.ownLines(a.replica.s))[line.discussion];
    let meta=JSON.parse(await R.git(a.replica.s.store,['cat-file','blob',`${own.commit}:${R.META}`]));
    assert.equal(meta.outcome,'failed');
    const replies=['an idea','PASS',new Error('summary failed')];
    a.room=createRoom([{name:'A',provider:'claude',turn:async()=>{const r=replies.shift();if(r instanceof Error)throw r;return r??'PASS';}}],a.state);
    await ui.handleLine('failed auto summary',a);
    own=(await R.ownLines(a.replica.s))[line.discussion];
    meta=JSON.parse(await R.git(a.replica.s.store,['cat-file','blob',`${own.commit}:${R.META}`]));
    assert.equal(meta.outcome,'failed'); assert.equal(meta.summary,'failed');
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
// one replica: each saves and sends its own rounds, and closing one doesn't stop the peers.
test('every open discussion of a --node launch room replicates, through the launch room\'s replica', async () => {
  const root = await fs.mkdtemp(join(tmpdir(),'replication-ctx-')), rooms=[];
  const room = async (fields) => {
    const ctx = {port:0,agentSpecs:'claude:A',workerSpec:'claude:W',sessions:new Map(),state:{transcript:[],seen:new Map()},say:()=>{},...fields};
    Object.assign(ctx, await ui.load(ctx, ''));
    ctx.hub.rooms.set(ctx.key, ctx);
    ctx.usage={...ctx.usage,fetchQuota:async()=>null};
    ctx.room=createRoom([{name:'A',provider:'claude',turn:async()=> 'PASS'}],ctx.state);
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
    await wait(async()=> (await R.receivedLines(b.replica.s)).length===1);
    // A second open discussion in Mac's launch folder, as New discussion makes it.
    const second = await room({cwd:a.cwd,key:`${a.key}#d1`,context:'d1',hub:a.hub,launch:false});
    second.suggestTitle=async()=>({title:'Second topic'});
    assert.deepEqual([second.node, second.replica, second.screen.replicaOff], ['Mac', a.replica, null]);
    await ui.handleLine('a round in the second discussion',second);
    await wait(async()=> (await R.receivedLines(b.replica.s)).length===2);
    const titles=(await R.receivedLines(b.replica.s)).map((l)=>l.title).sort();
    assert.deepEqual(titles,['First topic','Second topic']);
    // Closing the second one leaves the replication running for the first.
    ui.ended(second); clearInterval(second.quotaTimer);
    assert.notEqual(a.replica.state.stopped,true);
    await ui.handleLine('another round in the first',a);
    const first=(await R.receivedLines(b.replica.s)).find((l)=>l.title==='First topic');
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
