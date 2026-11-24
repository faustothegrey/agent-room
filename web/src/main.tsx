import { createRoot } from 'react-dom/client';
import type { ScreenEvent } from '../../src/contract';

// The shell will consume this contract in the next migration step.
export type RoomEvent = ScreenEvent;

createRoot(document.getElementById('root')!).render(<main><h1>agent-room</h1><p>The new room page is being built.</p></main>);

// This stream is separate from the existing room page's events.
const version = document.querySelector<HTMLMetaElement>('meta[name="agent-room-next-version"]')?.content;
const versions = new EventSource('./__next/events');
versions.onmessage = (event) => {
  const next: { version: string | null } = JSON.parse(event.data);
  if (next.version && version && next.version !== version) location.reload();
};
