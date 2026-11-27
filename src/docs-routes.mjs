// Screen HTTP routes. The facade supplies the current page and reloadable helpers.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { extname, join } from 'node:path';
import { handleShell } from './host-shell.mjs';
import { handleNotes } from './notes.mjs';

export function createRoutes({ broadcast, resetEvent, handleNext, files }) {
const { docFiles, servable, isViewable, roomBranch } = files;
// Input endpoints accept only the page itself: same host, JSON. A page on another site can't send
// a JSON POST here without a CORS preflight, which this server never approves, and the Host check
// stops DNS-rebinding tricks. That matters because the agents act on what the User says.
// The room listens on the LAN too: this machine's own addresses and names count as its own host.
function ownHost(host) {
  const name = host.replace(/:\d+$/, '').toLowerCase();
  const mine = ['127.0.0.1', 'localhost', hostname().toLowerCase(), `${hostname().toLowerCase().replace(/\.local$/, '')}.local`,
    ...Object.values(networkInterfaces()).flat().filter((i) => i.family === 'IPv4').map((i) => i.address)];
  return mine.includes(name);
}
// The machine's short name for the header (not the --node name): hostname up to its first dot
// (Machiste.local → Machiste) unless it is an IPv4 address; else the first LAN IPv4 address.
function shortHost() {
  try {
    const name = hostname().trim();
    const short = /^\d{1,3}(\.\d{1,3}){3}$/.test(name) ? name : name.split('.')[0];
    if (short) return short;
  } catch {}
  try { return Object.values(networkInterfaces()).flat().find((i) => i?.family === 'IPv4' && !i.internal)?.address ?? null; } catch { return null; }
}
function fromOwnPage(req) {
  const host = req.headers.host ?? '';
  if (!ownHost(host)) return false;
  if (req.headers.origin && req.headers.origin !== `http://${host}`) return false;
  return (req.headers['content-type'] ?? '').startsWith('application/json');
}

// Attachments to a discussion message: saved into its files/ folder, each file at most 25 MB. They
// travel base64-encoded inside /__say's JSON body (so the same-page check applies), at most
// ATTACH_TOTAL bytes per message.
const ATTACH_LIMIT = 25 * 1024 * 1024;
const ATTACH_TOTAL = 250 * 1024 * 1024;
const attachName = (name) => String(name ?? '').split(/[\\/]/).pop().replace(/[\x00-\x1f]/g, '').replace(/^\.+/, '').trim() || 'file';
// Saves files ([{ name, data: base64 }]) into folder, created if missing. A name already there is saved
// as name-2.ext, name-3.ext, …: nothing is overwritten. All or nothing: on any failure, the files saved
// by this call are removed and the error is thrown. Returns the names saved, in order.
function saveAttachments(folder, files) {
  const blobs = files.map((f) => {
    const name = attachName(f?.name);
    if (typeof f?.data !== 'string') throw new Error(`${name}: no content.`);
    const data = Buffer.from(f.data, 'base64');
    if (data.length > ATTACH_LIMIT) throw new Error(`${name} is over 25 MB.`);
    return { name, data };
  });
  const saved = [];
  try {
    mkdirSync(folder, { recursive: true });
    for (const { name, data } of blobs) {
      const ext = extname(name), stem = name.slice(0, name.length - ext.length);
      for (let n = 1; ; n++) {
        const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
        try { writeFileSync(join(folder, candidate), data, { flag: 'wx' }); saved.push(candidate); break; } catch (err) {
          if (err.code === 'EEXIST') continue;
          try { rmSync(join(folder, candidate), { force: true }); } catch {} // created by this call, partly written
          throw err;
        }
      }
    }
  } catch (err) {
    removeAttachments(folder, saved);
    throw err;
  }
  return saved;
}
const removeAttachments = (folder, names) => { for (const f of names) rmSync(join(folder, f), { force: true }); };

function readJson(req, limit = 100_000) {
  return new Promise((done) => {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > limit) req.destroy(); });
    req.on('end', () => { try { done(JSON.parse(body)); } catch { done(null); } });
  });
}

// Serves the page, its event stream, the file list and the two inputs (say, show); returns false
// for any other path.
function handleScreen(req, res, url, dir, screen) {
  const send = (status, type, body) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
  if (handleNext(req, res, url, screen)) return true;
  if (handleShell(req, res, url)) return true; // the terminal pane (host-shell.mjs)
  if (handleNotes(req, res, url, dir)) return true; // the Notes pane (notes.mjs)
  // The heartbeat: the page and the Dock app ask every few seconds; a new pid means a new process.
  if (url.pathname === '/__health') {
    send(200, 'application/json', JSON.stringify({ app: 'agent-room', pid: process.pid, root: dir, host: shortHost(),
      startedAt: screen.startedAt ?? null, discussion: screen.room?.active ?? null, pages: screen.clients.size }));
    return true;
  }
  if (url.pathname === '/__rooms') {
    if (req.method !== 'GET') { send(405, 'text/plain', 'Use GET.'); return true; }
    if (!screen.listRooms) { send(409, 'text/plain', 'Room discovery is unavailable.'); return true; }
    screen.listRooms().then((rooms) => send(200, 'application/json', JSON.stringify(rooms)),
      (err) => send(500, 'text/plain; charset=utf-8', err.message));
    return true;
  }
  if (url.pathname === '/__provider-health') {
    if (!screen.providerHealth || !screen.checkProviderHealth) { send(409, 'text/plain', 'Provider health is unavailable.'); return true; }
    if (req.method !== 'GET' && (req.method !== 'POST' || !fromOwnPage(req))) { send(403, 'text/plain', 'Refused.'); return true; }
    Promise.resolve().then(() => req.method === 'GET' ? screen.providerHealth() : screen.checkProviderHealth()).then(
      (data) => send(200, 'application/json', JSON.stringify(data)), (err) => send(500, 'text/plain; charset=utf-8', err.message));
    return true;
  }
  if (url.pathname === '/__prompt-test') {
    if (req.method !== 'POST' || !fromOwnPage(req)) { send(403, 'text/plain', 'Refused: only the room page can run a prompt test.'); return true; }
    if (!screen.testPrompt) { send(409, 'text/plain', 'Prompt tests are unavailable in this room.'); return true; }
    readJson(req).then((body) => screen.testPrompt(body)).then(
      (result) => send(200, 'application/json', JSON.stringify(result)),
      (err) => send(400, 'text/plain; charset=utf-8', err.message));
    return true;
  }
  // The Instructions tab: the prompt catalog, with each rulebook's current text.
  if (url.pathname === '/__instructions') {
    if (req.method !== 'GET') { send(405, 'text/plain', 'Use GET.'); return true; }
    if (!screen.instructions) { send(409, 'text/plain', 'Instructions are unavailable in this room.'); return true; }
    try { send(200, 'application/json', JSON.stringify(screen.instructions())); }
    catch (err) { send(500, 'text/plain; charset=utf-8', err.message); }
    return true;
  }
  // The Schedule page: recurring discussion tasks and quota floor for this room.
  if (url.pathname === '/__schedule') {
    if (!screen.getSchedule || !screen.saveSchedule) { send(409, 'text/plain', 'Schedule is unavailable in this room.'); return true; }
    if (req.method === 'GET') {
      Promise.resolve().then(() => screen.getSchedule()).then(
        (data) => send(200, 'application/json', JSON.stringify(data)),
        (err) => send(500, 'text/plain; charset=utf-8', err.message));
      return true;
    }
    if (req.method !== 'POST' || !fromOwnPage(req)) { send(403, 'text/plain', 'Refused: only the room page can update the schedule.'); return true; }
    readJson(req).then((body) => screen.saveSchedule(body)).then(
      (result) => send(200, 'application/json', JSON.stringify(result)),
      (err) => send(400, 'text/plain; charset=utf-8', err.message));
    return true;
  }
  if (url.pathname === '/__files') {
    let files = [];
    try { files = docFiles(dir, screen); } catch {} // no discussions/ yet
    if (url.searchParams.get('detail') === '1') {
      const unviewable = files.filter((f) => {
        const full = servable(dir, f, screen);
        return full ? !isViewable(full) : false;
      });
      const branch = roomBranch(dir);
      send(200, 'application/json', JSON.stringify({ files, unviewable, branch }));
      return true;
    }
    send(200, 'application/json', JSON.stringify(files));
    return true;
  }
  if (url.pathname === '/__settings') {
    if (!screen.getSettings || !screen.saveSettings) { send(409, 'text/plain', 'Settings are unavailable in this room.'); return true; }
    if (req.method === 'GET') {
      Promise.resolve().then(() => screen.getSettings()).then(
        (settings) => send(200, 'application/json', JSON.stringify(settings)),
        (err) => send(500, 'text/plain; charset=utf-8', err.message));
      return true;
    }
    if (req.method !== 'POST' || !fromOwnPage(req)) { send(403, 'text/plain', 'Refused: only the room page can save settings.'); return true; }
    readJson(req).then((body) => screen.saveSettings(body)).then(
      (result) => send(200, 'application/json', JSON.stringify(result)),
      (err) => send(400, 'text/plain; charset=utf-8', err.message));
    return true;
  }
  // A received snapshot's files, while its line is open in View (or still its latest round).
  if (url.pathname === '/__rfiles') {
    const q = url.searchParams;
    send(200, 'application/json', JSON.stringify(screen.receivedFiles?.(q.get('d') ?? '', q.get('n') ?? '', q.get('c') ?? '') ?? []));
    return true;
  }
  if (['/__view', '/__pair'].includes(url.pathname)) {
    if (req.method !== 'POST' || !fromOwnPage(req)) { send(403, 'text/plain; charset=utf-8', 'Refused: only the room page can do this.'); return true; }
    const act = url.pathname === '/__view' ? screen.view : screen.pair;
    if (!act) { send(409, 'text/plain; charset=utf-8', 'This room doesn\'t replicate (start it with --node).'); return true; }
    readJson(req).then((body) => (url.pathname === '/__view' ? act({ ...body, client: req.headers['x-view-client'] }) : act(String(body?.peer ?? ''), !!body?.confirm))).then(
      (result) => send(200, 'application/json', JSON.stringify(result)),
      (err) => send(400, 'text/plain; charset=utf-8', err.message));
    return true;
  }
  if (['/__say', '/__show', '/__work', '/__workerinfo', '/__newroom', '/__retry', '/__agent-enabled', '/__cancelclose', '/__stopworker', '/__discard', '/__merge', '/__catchup'].includes(url.pathname)) {
    if (req.method !== 'POST' || !fromOwnPage(req)) { send(403, 'text/plain; charset=utf-8', 'Refused: only the room page can send input.'); return true; }
    readJson(req, url.pathname === '/__say' ? ATTACH_TOTAL * 1.4 : undefined).then((body) => {
      if (url.pathname === '/__newroom') {
        if (!screen.newRoom) return send(409, 'text/plain; charset=utf-8', 'This room can\'t open another one.');
        // {}: the chooser's answer; { token }: Create room for that answer (see newRoom in ui.mjs).
        return screen.newRoom(body ?? {}).then((r) => send(200, 'application/json', JSON.stringify(r)),
          (err) => send(err.status ?? 500, 'text/plain; charset=utf-8', err.message));
      }
      if (url.pathname === '/__show') {
        const target = typeof body?.file === 'string' ? servable(dir, body.file, screen) : null;
        if (!target || !isViewable(target)) return send(404, 'text/plain; charset=utf-8', 'No such document.');
        screen.doc = body.file;
        broadcast(screen, { type: 'doc', file: body.file });
        return send(204, 'text/plain', '');
      }
      if (url.pathname === '/__workerinfo') { // the Worker tab is shown: recheck its branches (sent as a workerinfo event)
        screen.refreshWorker?.();
        return send(204, 'text/plain', '');
      }
      if (url.pathname === '/__cancelclose') {
        if (screen.isViewing?.(req.headers['x-view-client'])) return send(409, 'text/plain', 'Read-only: return to this node before cancelling Close.');
        if (!screen.cancelClose?.(body?.name)) return send(409, 'text/plain; charset=utf-8', 'Close is no longer waiting for the worker.');
        return send(204, 'text/plain', '');
      }
      if (url.pathname === '/__discard') {
        if (screen.isViewing?.(req.headers['x-view-client'])) return send(409, 'text/plain', 'Read-only: return to this node before discarding worker work.');
        if (!screen.discardPreview || !screen.closeAndDiscard) return send(409, 'text/plain; charset=utf-8', 'Close and Discard is unavailable.');
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (!name) return send(400, 'text/plain; charset=utf-8', 'Discussion name is required.');
        const act = body?.snapshot ? screen.closeAndDiscard(name, String(body.snapshot)) : screen.discardPreview(name);
        return Promise.resolve(act).then(
          (result) => send(200, 'application/json', JSON.stringify(result)),
          (err) => send(409, 'text/plain; charset=utf-8', err.message));
      }
      if (url.pathname === '/__merge') {
        if (screen.isViewing?.(req.headers['x-view-client'])) return send(409, 'text/plain', 'Read-only: return to this node before merging worker work.');
        if (!screen.mergePreviewClose || !screen.closeAndMerge) return send(409, 'text/plain; charset=utf-8', 'Close and Merge is unavailable.');
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (!name) return send(400, 'text/plain; charset=utf-8', 'Discussion name is required.');
        const act = body?.snapshot ? screen.closeAndMerge(name, String(body.snapshot)) : screen.mergePreviewClose(name);
        return Promise.resolve(act).then(
          (result) => send(200, 'application/json', JSON.stringify(result)),
          (err) => send(409, 'text/plain; charset=utf-8', err.message));
      }
      if (url.pathname === '/__catchup') {
        if (screen.isViewing?.(req.headers['x-view-client'])) return send(409, 'text/plain', 'Read-only: return to this node before catching up.');
        if (!screen.catchUpMerge) return send(409, 'text/plain; charset=utf-8', 'Catch up is unavailable.');
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (!name) return send(400, 'text/plain; charset=utf-8', 'Discussion name is required.');
        return Promise.resolve(screen.catchUpMerge(name)).then(
          (result) => send(200, 'application/json', JSON.stringify(result)),
          (err) => send(409, 'text/plain; charset=utf-8', err.message));
      }
      if (url.pathname === '/__agent-enabled') {
        if (screen.isViewing?.(req.headers['x-view-client'])) return send(409, 'text/plain', 'Read-only: return to this node before changing discussion agents.');
        if (!screen.setAgentEnabled) return send(409, 'text/plain', 'Discussion agent controls are unavailable.');
        return Promise.resolve().then(() => screen.setAgentEnabled(body?.name, body?.enabled, body?.member === true)).then(() => send(204, 'text/plain', ''), (err) => send(400, 'text/plain', err.message));
      }
      if (url.pathname === '/__retry') {
        if (!screen.retryWork) return send(409, 'text/plain', 'Retry is unavailable.');
        return Promise.resolve(screen.retryWork(body?.id, body?.settings)).then(() => send(204, 'text/plain', ''), (err) => send(400, 'text/plain', err.message));
      }
      if (url.pathname === '/__stopworker') {
        if (screen.isViewing?.(req.headers['x-view-client'])) return send(409, 'text/plain', 'Read-only: return to this node before stopping the worker.');
        if (!screen.stopWorker) return send(409, 'text/plain', 'Stopping the worker is unavailable.');
        try { screen.stopWorker(body?.mode); } catch (err) { return send(400, 'text/plain', err.message); }
        return send(204, 'text/plain', '');
      }
      if (url.pathname === '/__work') {
        if (screen.peek) return send(409, 'text/plain; charset=utf-8', 'Read-only: you are peeking at a closed board. Click Back to return to the active discussion first.');
        if (!screen.work) return send(409, 'text/plain; charset=utf-8', 'This room has no worker input; the page only watches.');
        if (typeof body?.text !== 'string' || !body.text.trim()) return send(400, 'text/plain; charset=utf-8', 'Nothing to send.');
        screen.work(body.text.trim());
        return send(204, 'text/plain', '');
      }
      if (!screen.say) return send(409, 'text/plain; charset=utf-8', 'This room is typed in the terminal; the page only watches.');
      const files = Array.isArray(body?.files) && body.files.length ? body.files : null;
      if (typeof body?.text !== 'string' || (!body.text.trim() && !files)) return send(400, 'text/plain; charset=utf-8', 'Nothing to send.');
      // While peeking at a closed board, non-command messages and attachments are refused so nothing can go to the wrong board.
      if (screen.peek && (files || !body.text.trim().startsWith('/'))) return send(409, 'text/plain; charset=utf-8', 'Read-only: you are peeking at a closed board. Click Back to return to the active discussion first.');
      // While another node's line is open in View, it is read-only: only these commands pass.
      if (screen.isViewing?.(req.headers['x-view-client']) && !VIEW_COMMANDS.includes(body.text.trim())) return send(409, 'text/plain; charset=utf-8', `Read-only: you are viewing a received line. Go back to this node's line first.`);
      if (files) return sayWithFiles(body.text.trim(), files, body.confirmed === true);
      const warning = screen.say(body.text.trim(), body.confirmed === true);
      if (typeof warning === 'string') return send(409, 'text/plain; charset=utf-8', warning);
      send(204, 'text/plain', '');
    });
    return true;
  }
  // A message with attachments: every file is saved into the discussion's or brainstorm's files/ first, and their
  // paths are appended to the text; if any save fails, or the message isn't taken, nothing stays saved.
  function sayWithFiles(text, files, confirmed) {
    const fail = (status, message) => send(status, 'text/plain; charset=utf-8', message + ' Nothing was sent.');
    const active = screen.room?.active;
    if (!active) return fail(409, 'Attachments need a started discussion or brainstorm.');
    if (text.startsWith('/')) return fail(400, 'Attachments go with a message, not a command.');
    const folder = join(dir, active, 'files');
    let saved;
    try { saved = saveAttachments(folder, files); } catch (err) { return fail(/over 25 MB/.test(err.message) ? 413 : 400, `Couldn't save the attachments: ${err.message}`); }
    const line = (text ? text + '\n\n' : '') + 'Attached: ' + saved.map((f) => 'files/' + f).join(', ');
    let warning;
    try { warning = screen.say(line, confirmed); } catch (err) { warning = err.message; }
    if (typeof warning === 'string') { removeAttachments(folder, saved); return fail(409, warning); }
    send(204, 'text/plain', '');
  }
  if (url.pathname !== '/__events') return false;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  screen.clients.add(res);
  req.on('close', () => screen.clients.delete(res));
  // A page that (re)connects first gets everything so far, so it never shows a partial room.
  res.write(`data: ${JSON.stringify(resetEvent(screen))}\n\n`);
  return true;
}

// What the page can still send while viewing another node's line.
const VIEW_COMMANDS = ['/usage', '/reload', '/restart', '/quit', '/shutdown'];


return { fromOwnPage, ATTACH_LIMIT, ATTACH_TOTAL, saveAttachments, handleScreen, ownHost };
}
