// Values sent as JSON on /__events. Optional fields may be absent from the serialized event.
export interface TranscriptEntry {
  speaker: string;
  text?: string | null;
  error?: unknown;
  pass?: unknown;
  summary?: unknown;
  outcome?: string;
  by?: string;
}
export interface MessageView {
  speaker: string;
  html: string;
  error: boolean;
  pass: boolean;
  errorText?: string;
  hidden?: boolean;
  outcome?: string;
  origin?: string;
  owner?: string | null;
  retryId?: string;
  meta?: unknown;
}
export interface WorkerNote {
  note: string; error?: boolean; origin?: string; owner?: string | null;
  room?: boolean; recipients?: (string | null)[];
}
export type WorkerMessage = MessageView | WorkerNote;
export interface Peek {
  name: string;
  ref: string;
  path: string;
  kind: 'brainstorm' | 'workbench' | 'research' | 'discussion';
  title: string;
  messages: MessageView[];
  worker?: WorkerMessage[];
  doc: string | null;
}
export interface Gauge { provider: string; group?: string; label: string; used: number; resets: string | null }
export interface QuotaAt { measured: string | null; providers?: Record<string, string | null>; checked: string }
export interface WorkerPending { lane: string | null; branch: string; ahead: number; dirty: boolean; conflicts: string[] }
export interface MergeReadiness { canMerge: boolean; catchUp: boolean; disabledReason?: string | null; targetBranch?: string | null; behind?: number }
export interface WorkerLane { summary: string; lines: string[]; own?: boolean; diagram?: { note?: string; graph?: string } }
export interface WorkerInfo { lines: string[]; disabled?: boolean; error?: boolean; lanes?: WorkerLane[]; pending?: WorkerPending[]; discardable?: string[]; mergeable?: Record<string, MergeReadiness>; merged?: string[] }
export interface OpenBoard { url: string; current: boolean; title: string; active: string | null; brainstorm: boolean; workbench: boolean; research: boolean; started: boolean; working: boolean; workerBusy: boolean; ongoing: boolean; waitingForInput?: boolean; waitingReason?: string | null; readyForAutoDev?: boolean; workReady?: boolean }
export interface BoardCheckpoint { name: string; title?: string; at?: string; kind?: string; summary?: boolean }
export interface BoardRollback { name: string; status: string; report?: string | null; commit?: string | null }
export interface ResearchStats { laps: number; priorUnknown?: boolean; lastRun?: string | null; nextRun?: string | null }
export interface AutoDev { status: 'running' | 'paused' | 'finished' | null; cycle: number; max: number; reason: string | null; waiting: boolean; offer: { text?: string; error?: string } | null }
export interface WorkerStop { after: boolean; now: boolean }
export interface StopWorkerRequest { mode: 'after' | 'now' }
// The agents a discussion started with (the members panel), and the CLI sessions of its agents and worker.
export interface Member { provider: AgentSettings['provider']; name: string; model: string; modelLabel: string; enabled: boolean }
export interface CliSession { name: string; provider: string; id: string | null }
export interface CliSessions { agents: CliSession[]; worker: CliSession | null }
export interface Room {
  folder: string; ownCheckout?: boolean; agents: string[]; worker: string; workerModel: string | null;
  cliSessions: CliSessions | null; discussion: string; active: string | null; started: boolean;
  fresh: boolean; brainstorm: boolean; workbench: boolean; research: boolean;
  workbenches: string[]; researches: string[]; researchStats: Record<string, ResearchStats>; members: Member[];
  failedAgents: { name: string; disabled: boolean }[]; autoDev: AutoDev | null; workerStop: WorkerStop | null;
  retryId: string | null; transcript: string | null; checkpoints: BoardCheckpoint[]; closedDiscussions: string[];
  closingDiscussions: Record<string, string>; busyWorkers: string[]; back: unknown; code: CodeInfo | null;
  rollbacks: BoardRollback[]; multi: boolean; open: OpenBoard[];
}
export interface MonitorLogin { state: 'ok' | 'ending' | 'expired' | 'out' | 'unknown' | 'unmonitored'; expiresAt?: string | null; error?: string | null }
export interface Leftover { pid: number; agent: string; room: string; started: string; provider: string; unverified?: boolean }
export type Monitor = Record<string, { login: MonitorLogin | null; running: number; leftovers: Leftover[]; inRoom: boolean }>;
// The checkout the server runs (codeInfo in ui.mjs), shown beside the server's state.
export interface CodeInfo { path: string; branch: string | null; commit: string | null; dirty: boolean; startedAt?: string | null; reloaded?: { at: string; commit: string | null; dirty: boolean } }
// GET __health (the heartbeat, every 3 s); 404 when this room is no longer on the server.
export interface HealthReply { app: 'agent-room'; pid: number; root: string; startedAt: string | null; discussion: string | null; pages: number }
// Replication (replicaStatus in ui.mjs): this node's own lines, the lines received from peers, and the peers.
export interface ProjectVersion { commit: string | null; dirty: boolean }
export interface OwnLine { discussion: string; round: number; sent: Record<string, boolean> }
export interface ReceivedLine { discussion: string; node: string; commit: string; round: number; kind?: string; outcome?: string; name?: string | null; title?: string | null; at?: string; receivedAt?: string | null; local: string | null }
export interface ReplicaPeer { name: string; address: string; reachable: boolean | null; since: string | null; activity: string | null; project: ProjectVersion | null; paired: boolean; mismatch: boolean; error: string | null }
export interface Replica { node: string; addresses: string[]; roomId: string; project: ProjectVersion | null; own: Record<string, OwnLine>; received: ReceivedLine[]; peers: ReplicaPeer[] }
// POST __view: { discussion, node } pins a received line for this browser, { renew: true } keeps the
// pin, { back: true } releases it. Replies { viewing }: the pinned line with its chat, true (renewed), or null.
export type ViewRequest = { discussion: string; node: string } | { renew: true } | { back: true };
export interface ViewedLine { discussion: string; node: string; commit: string; round: number; kind?: string; outcome?: string; name?: string | null; title?: string | null; receivedAt: string | null; messages: MessageView[] }
export interface ViewReply { viewing: ViewedLine | true | null }
// POST __pair: { peer } checks (both rooms' folders), { peer, confirm: true } pairs.
export interface PairRequest { peer: string; confirm?: boolean }
export interface PairCheck { local: { node: string; root: string; roomId: string | null }; peer: { node: string; root: string } }
// My notes (notes.mjs, the room's own Hosts, LAN ones too; stored on the agent-room computer): GET __notes lists them, GET __notes/read?id= reads one
// ({ …entry, text }); POST __notes/new { text }, __notes/save { id, text } (404: removed meanwhile), __notes/remove { id }.
export interface NoteEntry { id: string; title: string; tags: string[]; savedAt: string }
export type NoteRequest = { text: string } | { id: string; text: string } | { id: string };
export interface NoteSaved { id: string; title?: string; savedAt: string }
// GET/POST __schedule (Schedule service): the quota floor and the scheduled research tasks; a POST
// { action, … } (floor, toggle, delete, add, edit) answers with the new schedule.
export interface ScheduleRun { at?: string | null; status: 'ran' | 'skipped' | 'stopped' | 'failed' | string; reason?: string | null }
export interface ScheduleTask { id: string; kind: 'research' | 'recurring'; title?: string | null; board?: string | null; date?: string; time: string; prompt: string; enabled: boolean; running?: boolean; lastRun?: ScheduleRun | null }
export interface ScheduleData { quotaFloor?: number; tasks: ScheduleTask[] }
export type ScheduleRequest = { action: 'floor'; quotaFloor: number } | { action: 'toggle'; id: string; enabled: boolean } | { action: 'delete'; id: string }
  | ({ action: 'add' } | { action: 'edit'; id: string }) & ({ kind: 'research'; title: string; date: string; time: string; prompt: string } | { kind: 'recurring'; title: string; time: string; prompt: string; enabled: boolean });
// GET __instructions (Instructions service): the prompt catalog, read-only.
export interface InstructionSet { type: string; pieces: { id: string; intent: string; when: string; content: string }[] }
// GET __provider-health (POST: check now) and POST __prompt-test { provider, model } (Providers service).
type HealthError = { at: string; message: string } | null | undefined;
export interface HealthAgent { role: string; name: string; provider: string; model: string; alignment?: string; enabled?: boolean }
export interface ProviderHealthReply {
  cli: Record<string, { path: string; version: string; checked: string } | null>; login: Record<string, { state: string; expiresAt?: string | null; checked: string } | null>;
  errors: { cli: Record<string, (HealthError & { path?: string }) | { path?: string } | null | undefined>; login: Record<string, HealthError>; leftovers?: HealthError };
  scheduledProviders: string[]; nextLogin: string | null; catalogs: Record<string, { loaded: boolean; checked: string | null; models: unknown[]; error?: HealthError }>;
  configured: { room: string; discussion: string | null; agents: HealthAgent[] }[]; defaults: HealthAgent[] | null;
  permissions?: Record<string, PermissionReport> | null;
  promptRunning: string[]; promptResults: { provider: string; model: string; at: string; durationMs: number; outcome: string; reply?: string | null; error?: string | null }[];
  sessions: { room: string; discussion: string | null; agents: { role: string; name: string; provider: string; id: string | null; lastTurn?: { ended: string; outcome: string; error?: { at: string; message: string } | null } | null }[] }[];
  leftoversChecked: string | null; nextLeftovers: string | null; running: HealthProgram[]; leftovers: HealthProgram[];
  quota: { room: string; reachable: boolean | null; measured: string | null; providers?: Record<string, string | null>; checked: string | null }[];
}
// One provider's permission check (agents.mjs, permissionReport): its launch mode, its config file's
// reading and (Claude) the live mode from a Test prompt's init event.
export interface PermissionReport {
  launch: string; state: 'ok' | 'problem' | 'unknown'; mode: string | null; problems: string[]; checked: string | null;
  config: { file: string; found?: boolean; error?: string } | null; live: { mode: string; at: string } | null;
}
export interface HealthProgram { pid: number; provider: string; agent: string; room: string; started?: string | null; unverified?: boolean }
export interface PromptTestRequest { provider: string; model: string }
// GET __shell/token (host-shell.mjs, pages on this computer only): the WebSocket's token.
export interface ShellTokenReply { token: string }
// GET __rooms: this server's rooms, for Switch room….
export interface RoomEntry { id: string; path: string; root: string; discussion: string | null; pages: number | null; current: boolean }
// POST __newroom: {} asks the server's folder chooser; { token } creates the room it asked about; { token, cancel: true } drops it.
export type NewRoomRequest = Record<string, never> | { token: string; cancel?: boolean };
export interface NewRoomReply { cancelled?: boolean; confirm?: boolean; token?: string; folder?: string; url?: string; existing?: boolean; open?: boolean }
export interface ResetEvent {
  type: 'reset'; messages: MessageView[]; doc?: string | null; thinking?: string | null;
  status?: string | null; busy: boolean; input: boolean; room: Room | null; worker: WorkerMessage[];
  working: string | null; workInput: boolean; workerInfo: WorkerInfo | null;
  quota?: Gauge[] | null; quotaAt: QuotaAt | null; monitor: Monitor | null; newRoom: boolean;
  page: string; webVersion: string | null; replica: Replica | null; replicaOff: string | null; viewing: unknown; peek: Peek | null;
  startup?: string | null; // the latest startup checks' summary of problems (monitor.mjs), or null
}
export type ScreenEvent = ResetEvent
  | { type: 'message'; message: MessageView }
  | { type: 'work'; message: WorkerMessage }
  | { type: 'thinking' | 'working'; name: string | null }
  | { type: 'turn'; text: string }
  | { type: 'room'; room: Room }
  | { type: 'workerinfo'; info: WorkerInfo }
  | { type: 'quota'; gauges: Gauge[] | null | undefined; at: QuotaAt | null | undefined }
  | { type: 'monitor'; monitor: Monitor | null }
  | { type: 'replica'; replica: Replica | null }
  | { type: 'note'; text: string; error?: boolean }
  | { type: 'busy'; on: boolean }
  | { type: 'doc'; file: string | null }
  | { type: 'moved'; from: string; to: string | null }
  | { type: 'goto'; url: string }
  | { type: 'reloaded'; page: string; webVersion: string | null }
  | { type: 'web-version'; webVersion: string | null }
  | { type: 'agent-failure'; agent: string; error: string }
  | { type: 'files' | 'schedule' | 'ended' | 'restarting' };

// The minimal state the checked helpers need; streams are structural to avoid Node typings.
export interface Screen {
  clients: Set<{ write(data: string): unknown; end(data: string, done: () => void): unknown }>;
  transcript: TranscriptEntry[]; doc?: string | null; thinking?: string | null; status?: string | null;
  nextDist?: string; busy?: unknown; say?: unknown; room?: Room | null; workerForPage?: () => WorkerMessage[];
  worker?: WorkerMessage[]; working?: string | null; work?: unknown; workerInfo?: WorkerInfo | null;
  quota?: Gauge[] | null; quotaAt?: QuotaAt | null; monitor?: Monitor | null; newRoom?: unknown;
  replica?: Replica | null; replicaOff?: string | null; viewing?: unknown; peek?: Peek | null; startup?: string | null;
}

// First routes used by the React page. Event-stream bodies consist of ScreenEvent JSON frames.
export interface NextPageRequest { method?: string; url?: string }
export type NextAssetRequest = NextPageRequest;
export interface EventsRequest { method?: string; url?: string }
// Successful page and asset responses have a 200 status; missing assets/builds return plain text 404,
// and unsupported methods return plain text 405. The SSE endpoint writes ScreenEvent frames.
export type NextRouteStatus = 200 | 404 | 405;
// The hub redirects the root page to the first room, or returns 404 when no room is open.
export type RootNextRouteStatus = 302 | 404;
export type NextRouteBody = string | Uint8Array;
export type EventStreamFrame = ScreenEvent;
export interface HttpReply {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body?: string | Uint8Array): unknown;
}
export interface EventsReply extends HttpReply { write(data: string): unknown }

// JSON sent by the conversation composer to POST /__say (with same-page headers).
export interface SayAttachment { name: string; data: string }
export interface AgentSettings { name: string; provider: 'claude' | 'codex' | 'agy'; model: string }
export interface RoomSettings { agents: AgentSettings[]; worker: AgentSettings; [key: string]: unknown }
// POST __settings: the settings to save, for the Discussion ('talk') or Worker ('work') panel.
export type SettingsSaveRequest = RoomSettings & { scope: 'talk' | 'work' } | { agents: AgentSettings[]; worker: AgentSettings; scope: 'defaults' };
export interface SettingsSaveReply { applied: boolean; workerApplied?: boolean; settings?: RoomSettings }
// POST __agent-enabled: an agent of this discussion left out (or back) from its next round; member: from the members panel.
export interface AgentEnabledRequest { name: string; enabled: boolean; member?: boolean }
export interface SettingsReply { settings: RoomSettings; defaults?: RoomSettings; launchDefaults?: RoomSettings; started: boolean; models: Record<AgentSettings['provider'], { id: string; label: string }[]> }
export interface RetryRequest { id: string; settings?: RoomSettings & { scope: 'work' } }
export interface WorkRequest { text: string }
export interface SayRequest { text: string; files?: SayAttachment[]; confirmed?: boolean }
export type SayReplyStatus = 204 | 400 | 403 | 409 | 413;

// File mentions and the read-only board view use these room-relative routes.
export interface FilesRequest { detail?: '1' }
export type FilesResponse = string[];
export interface FileDetailsResponse { files: string[]; unviewable: string[]; branch: string | null }
export interface ShowRequest { file: string }
export type ShowReplyStatus = 204 | 403 | 404;
// POST /__workerinfo requests an asynchronous workerinfo event.
export type WorkerInfoRequest = Record<string, never>;

// Preview requests omit snapshot; confirmations send the snapshot returned by the preview.
export interface BoardActionRequest { name: string; snapshot?: string }
export interface BoardCommit { hash: string; subject: string }
export interface MergePreview { name: string; branch: string; targetBranch: string; title: string; path: string; commits: BoardCommit[]; untracked: string[]; activeNotice?: string; snapshot: string }
export interface DiscardPreview { name: string; branch: string; path: string; worktreeExists: boolean; branchExists: boolean; commits: BoardCommit[]; tracked: { status: string; path: string }[]; untracked: string[]; ignored: { label: string }[]; snapshot: string }
export type MergeReply = { catchUp: true; targetBranch: string; behind: number; message: string } | { preview: MergePreview; changed?: boolean; ok?: boolean } | { ok: true; changed?: false };
export type DiscardReply = { preview: DiscardPreview; changed?: boolean; ok?: boolean } | { ok: true; changed?: false };
export interface CatchUpReply { ok: boolean; targetBranch: string }

// GET /__mtime?f=<room-relative file>: decimal mtime, "false" when unavailable,
// or "fixed" for an immutable received snapshot. Without f it lists room files.
export interface MtimeRequest { f?: string }
export type MtimeResponse = string;

// Messages exchanged between the room page and its embedded document viewer.
export interface PointMessage { type: 'agent-room:point'; label: string; text: string }
export interface HighlightMessage { type: 'agent-room:highlight'; ref: string; on: boolean }
