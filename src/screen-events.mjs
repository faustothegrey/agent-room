// @ts-check

/** @param {{parse(text: string): string}} md @param {() => string} page */
export function createScreenEvents(md, page) {
// A transcript entry as the page shows it: the text rendered as Markdown. Summary turns are
// hidden (only the summary's result is shown); the result carries its label.
/** @param {import("./contract.d.ts").TranscriptEntry} m @returns {import("./contract.d.ts").MessageView} */
function messageView(m) {
  /** @type {import("./contract.d.ts").MessageView} */
  const view = { speaker: m.speaker, html: md.parse(m.text ?? ''), error: !!m.error, pass: !!m.pass };
  if (m.error) view.errorText = m.text ?? '';
  if (m.summary) view.hidden = true;
  if (m.outcome) {
    view.outcome = m.outcome;
    view.speaker = m.outcome === 'agreed' ? `Summary — agreed, by ${m.by}` : `Summary — not agreed: the last version, by ${m.by}`;
  }
  return view;
}

// Sends one event ({ type, ... }) to every open screen. The last round's end line is remembered
// until the User speaks again, so a page opened later still shows that it is the User's turn.
/** @param {import("./contract.d.ts").Screen} screen @param {import("./contract.d.ts").ScreenEvent} event */
function broadcast(screen, event) {
  if (event.type === 'turn') screen.status = event.text;
  if (event.type === 'message' && event.message.speaker === 'User') screen.status = null;
  for (const res of screen.clients) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// Sends a last event to every open screen and closes their streams; resolves once it has gone out
// (or after a second), so the process can exit without dropping it.
/** @param {import("./contract.d.ts").Screen} screen @param {import("./contract.d.ts").ScreenEvent} event */
function endAll(screen, event) {
  const sent = [...screen.clients].map((res) => new Promise(/** @type {(done: (value: void) => void) => void} */ ((done) => {
    res.end(`data: ${JSON.stringify(event)}\n\n`, done);
  })));
  screen.clients.clear();
  return Promise.race([Promise.all(sent), new Promise(/** @type {(done: (value: void) => void) => void} */ ((done) => setTimeout(done, 1000)))]);
}

// Everything a page shows, to start over from: sent to a page that (re)connects, and to every open
// page when a discussion is resumed or started afresh.
/** @param {import("./contract.d.ts").Screen} screen @returns {import("./contract.d.ts").ResetEvent} */
function resetEvent(screen) {
  const peek = screen.peek ?? null;
  return { type: 'reset', messages: peek ? peek.messages : screen.transcript.map(messageView),
    doc: peek ? peek.doc : screen.doc,
    thinking: screen.thinking, status: screen.status, busy: !!screen.busy, input: !!screen.say,
    room: screen.room ?? null, worker: peek?.kind === 'workbench' ? (peek.worker ?? []) : (screen.workerForPage?.() ?? screen.worker ?? []), working: screen.working ?? null, workInput: !!screen.work, workerInfo: screen.workerInfo ?? null,
    quota: screen.quota, quotaAt: screen.quotaAt ?? null, monitor: screen.monitor ?? null, newRoom: !!screen.newRoom, page: page(),
    replica: screen.replica ?? null, replicaOff: screen.replicaOff ?? null, viewing: screen.viewing ?? null, peek };
}

return { messageView, broadcast, endAll, resetEvent };
}
