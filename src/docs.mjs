// Reloadable HTTP facade.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export { handleUpgrade } from './host-shell.mjs';
const version = new URL(import.meta.url).search;
const files = await import(`./docs-files.mjs${version}`);
const { createScreenEvents } = await import(`./screen-events.mjs${version}`);
const { createNextRoutes } = await import(`./docs-next.mjs${version}`);
const { createRoutes } = await import(`./docs-routes.mjs${version}`);
const { createFileRoutes } = await import(`./docs-http.mjs${version}`);
export const { isTextFile, isViewable, csvTable, listFiles, urlPath, docFiles, roomBranch } = files;

// Compatibility marker for pages opened before the React switch.
export const PAGE = '2e8ed6da2154';
// Each facade is built from modules loaded with its version tag.
const events = createScreenEvents(files.md, () => PAGE, (screen) => nextVersion(screen.nextDist));
export const { messageView, broadcast, endAll, resetEvent } = events;
const next = createNextRoutes(broadcast, { createHash, lstatSync, readdirSync, readFileSync, extname, join, fileURLToPath });
export const { nextVersion, notifyNext } = next;
const routes = createRoutes({ broadcast, resetEvent, handleNext: next.handleNext, files });
export const { fromOwnPage, ATTACH_LIMIT, ATTACH_TOTAL, saveAttachments } = routes;
export const { handle, pick } = createFileRoutes({ handleScreen: routes.handleScreen, ownHost: routes.ownHost, fromOwnPage: routes.fromOwnPage, files });
