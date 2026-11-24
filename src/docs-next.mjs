// @ts-check
// Built React page assets and versioning. Loaded with the current Reload version.
/** @typedef {{isDirectory(): boolean, isFile(): boolean, isSymbolicLink(): boolean}} FileInfo */
/** @typedef {FileInfo & {name: string}} DirEntry */
/** @typedef {Uint8Array & {toString(encoding?: string): string}} FileBytes */
/** @typedef {{ update(data: string | Uint8Array): unknown, digest(encoding: string): string }} Hash */
/** @typedef {{createHash(name: string): Hash, lstatSync(path: string): FileInfo,
 * readdirSync(path: string, options: {withFileTypes: true}): DirEntry[], readFileSync(path: string): FileBytes,
 * extname(path: string): string, join(...parts: string[]): string, fileURLToPath(url: URL): string}} Dependencies */
/** @param {(screen: import('./contract.d.ts').Screen, event: import('./contract.d.ts').ScreenEvent) => void} broadcast
 * @param {Dependencies} deps */
export function createNextRoutes(broadcast, deps) {
const { createHash, lstatSync, readdirSync, readFileSync, extname, join, fileURLToPath } = deps;
// Hash exactly the files the new page can serve. Symlinks are never followed.
const nextDir = new URL('../web/dist/', import.meta.url);
function nextVersion(dir = fileURLToPath(nextDir)) {
  try {
    const hash = createHash('sha256');
    /** @param {string} dir @param {string} prefix */
    const walk = (dir, prefix = '') => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = prefix + entry.name, path = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(path, name + '/');
        else if (entry.isFile()) { const bytes = readFileSync(path); hash.update(name + '\0' + bytes.length + '\0'); hash.update(bytes); }
      }
    };
    if (!lstatSync(dir).isDirectory() || !lstatSync(join(dir, 'index.html')).isFile()) return null;
    walk(dir);
    return hash.digest('hex');
  } catch { return null; }
}
/** @param {import('./contract.d.ts').Screen} screen */
function notifyNext(screen) {
  if (screen?.clients?.size) broadcast(screen, { type: 'web-version', webVersion: nextVersion(screen.nextDist) });
}
/** @param {import('./contract.d.ts').NextPageRequest} req @param {import('./contract.d.ts').HttpReply} res @param {URL} url @param {import('./contract.d.ts').Screen} screen */
function handleNext(req, res, url, screen) {
  /** @param {number} status @param {string} type @param {string | Uint8Array} body */
  const send = (status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache' }); res.end(body); };
  if (url.pathname !== '/__next' && !url.pathname.startsWith('/__next/')) return false;
  if (req.method !== 'GET') { send(405, 'text/plain; charset=utf-8', 'Use GET.'); return true; }
  const isPage = url.pathname === '/__next';
  let name;
  try { name = isPage ? 'index.html' : decodeURIComponent(url.pathname.slice('/__next/'.length)); }
  catch { send(404, 'text/plain; charset=utf-8', 'Not found'); return true; }
  if (!name || name.split(/[\\/]/).some((p) => !p || p === '.' || p === '..') || name.includes('\\')) {
    send(404, 'text/plain; charset=utf-8', 'Not found'); return true;
  }
  const root = screen.nextDist ?? fileURLToPath(nextDir), path = join(root, name);
  try {
    // Reject every symlink component, including ones that point back inside the build.
    if (!lstatSync(root).isDirectory()) throw new Error('invalid build root');
    let current = root;
    for (const part of name.split('/')) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error('symlink'); }
    if (!lstatSync(path).isFile()) throw new Error('not a file');
    const bytes = readFileSync(path);
    if (isPage) {
      const version = nextVersion(root);
      if (!version) throw new Error('missing build');
      const html = bytes.toString('utf8').replace(/(src|href)="\.\//g, '$1="./__next/').replace('</head>', `<meta name="agent-room-next-version" content="${version}"></head>`);
      send(200, 'text/html; charset=utf-8', html);
    } else {
      /** @type {Record<string, string>} */
      const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
      send(200, types[extname(name)] ?? 'application/octet-stream', bytes);
    }
  } catch { send(404, 'text/plain; charset=utf-8', isPage ? 'Web build missing. Run npm run build:web.' : 'Not found'); }
  return true;
}


return { nextVersion, notifyNext, handleNext };
}
