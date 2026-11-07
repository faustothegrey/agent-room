// Restart tests: receive one bundle as a separate process and exit abruptly (no cleanup, no
// `finally`) at the named point, as a killed or crashed server would.
// Usage: node crash-child.mjs <nodeDir> <room> <node> <peer> <bundleFile> <offerJSON> <point>
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openNode, receive } from './replica.mjs';

const [dir, room, node, peer, file, offer, point] = process.argv.slice(2);
const n = await openNode(dir, { room, node, peers: [peer] }); // a start: runs recovery
const saved = join(n.tmp, 'in-crash.bundle'); // where the HTTP endpoint would have saved the upload
await copyFile(file, saved);
await receive(n, saved, JSON.parse(offer), async (p) => { if (p === point) process.exit(86); });
process.exit(0); // the point was never reached
