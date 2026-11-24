import { createRoot } from 'react-dom/client';
import type { ScreenEvent } from '../../src/contract';

// The shell will consume this contract in the next migration step.
export type RoomEvent = ScreenEvent;

createRoot(document.getElementById('root')!).render(<main><h1>agent-room</h1><p>The new room page is being built.</p></main>);
