// The Notes pane's server side: the User's free-text notes, one set per room folder, kept on this
// computer only (never in the room's folder, never replicated) and served only to pages opened on
// this computer, with the terminal pane's checks (refusal() in host-shell.mjs). The agents are not
// told about them. One Markdown file per note, its first line the title; the file name is a
// timestamp and random letters, never the title, so no note overwrites another.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { refusal } from './host-shell.mjs';

export const NOTES_LIMIT = 1_000_000; // characters of one request's JSON
// Separated by room folder as the checkpoints are (ui.mjs, checkpointDirectory).
export const notesDirectory = (dir) => join(homedir(), '.local', 'share', 'agent-room', 'notes',
  createHash('sha256').update(realpathSync(dir)).digest('hex'));
const ID = /^\d{8}-\d{6}-[0-9a-f]{8}$/;
const newId = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15) + '-' + randomBytes(4).toString('hex');
// A last non-empty line is tags only if every token is a complete tag.
const metadata = (text) => {
  const lines = text.split('\n'), last = lines.findLastIndex((line) => line.trim());
  const line = last < 0 ? '' : lines[last].trim();
  const token = /#(?:([\p{L}\p{N}_-]+)|\[([^\[\]\r\n]+)\])/uy;
  const tags = []; let pos = 0;
  while (pos < line.length) {
    token.lastIndex = pos;
    const match = token.exec(line);
    if (!match) return { tags: [], title: titleOf(lines[0]) };
    const tag = (match[1] ?? match[2]).trim().replace(/\s+/g, ' ').toLowerCase();
    if (!tag) return { tags: [], title: titleOf(lines[0]) };
    tags.push(tag); pos = token.lastIndex;
    if (pos < line.length) {
      const spaces = /^[ \t]+/.exec(line.slice(pos));
      if (!spaces) return { tags: [], title: titleOf(lines[0]) };
      pos += spaces[0].length;
    }
  }
  return { tags: [...new Set(tags)], title: last === 0 && tags.length ? 'Untitled' : titleOf(lines[0]) };
};
const titleOf = (line) => line.replace(/^\s*#+\s*/, '').trim() || 'Untitled';
const entry = (folder, id) => {
  const file = join(folder, id + '.md'), text = readFileSync(file, 'utf8');
  return { id, ...metadata(text), savedAt: statSync(file).mtime.toISOString(), text };
};

export function listNotes(dir) {
  const folder = notesDirectory(dir);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((f) => ID.test(f.slice(0, -3)) && f.endsWith('.md'))
    .map((f) => { const { text, ...rest } = entry(folder, f.slice(0, -3)); return rest; })
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt) || b.id.localeCompare(a.id));
}
export function readNote(dir, id) {
  const folder = notesDirectory(dir);
  return ID.test(id) && existsSync(join(folder, id + '.md')) ? entry(folder, id) : null;
}
// A new note, under a name no other note has ('wx' never overwrites).
export function createNote(dir, text) {
  const folder = notesDirectory(dir);
  mkdirSync(folder, { recursive: true });
  for (;;) {
    const id = newId();
    try { writeFileSync(join(folder, id + '.md'), text, { flag: 'wx' }); return entry(folder, id); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
}
// Saves an existing note's text exactly as given (written aside, then renamed over it); null when
// there is no such note (removed meanwhile).
export function saveNote(dir, id, text) {
  const folder = notesDirectory(dir), file = join(folder, id + '.md');
  if (!ID.test(id) || !existsSync(file)) return null;
  const temp = join(folder, `.${id}.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(temp, text);
  renameSync(temp, file);
  return entry(folder, id);
}
export function removeNote(dir, id) {
  const file = join(notesDirectory(dir), id + '.md');
  if (!ID.test(id) || !existsSync(file)) return false;
  rmSync(file);
  return true;
}

function readJson(req) {
  return new Promise((done) => {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > NOTES_LIMIT) { done(undefined); req.destroy(); } });
    req.on('end', () => { try { done(JSON.parse(body)); } catch { done(null); } });
  });
}

// GET __notes (the list), GET __notes/read?id=…, and POST __notes/new { text }, __notes/save
// { id, text }, __notes/remove { id } (JSON only). False for other paths.
export function handleNotes(req, res, url, dir) {
  if (url.pathname !== '/__notes' && !url.pathname.startsWith('/__notes/')) return false;
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
    return true;
  };
  const text = (status, body) => send(status, body, 'text/plain; charset=utf-8');
  const why = refusal(req, { originRequired: false });
  if (why) { console.log(`[notes] refused ${url.pathname}: ${why[1]} (from ${req.socket.remoteAddress}, Host ${req.headers.host ?? 'none'})`); return text(why[0], why[1]); }
  const action = url.pathname.slice('/__notes/'.length);
  try {
    if (req.method === 'GET') {
      if (url.pathname === '/__notes') return send(200, listNotes(dir));
      if (action === 'read') { const n = readNote(dir, url.searchParams.get('id') ?? ''); return n ? send(200, n) : text(404, 'No such note.'); }
      return text(404, 'Not found.');
    }
    if (req.method !== 'POST' || !['new', 'save', 'remove'].includes(action)) return text(405, 'Method Not Allowed');
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return text(415, 'Send JSON.');
  } catch (err) { return text(500, err.message); }
  readJson(req).then((body) => {
    if (body === undefined) return text(413, 'The note is too long.');
    if (!body || typeof body !== 'object') return text(400, 'Send JSON.');
    const { id = '', text: note } = body;
    if (action !== 'remove' && typeof note !== 'string') return text(400, 'No text.');
    if (action === 'new') return send(201, createNote(dir, note));
    if (action === 'save') { const n = saveNote(dir, String(id), note); return n ? send(200, n) : text(404, 'This note no longer exists: it was removed.'); }
    return removeNote(dir, String(id)) ? text(204, '') : text(404, 'No such note.');
  }).catch((err) => text(500, err.message));
  return true;
}
