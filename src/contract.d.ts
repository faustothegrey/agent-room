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
export interface QuotaAt { measured: string | null; checked: string }
export interface WorkerInfo { lines: string[]; disabled?: boolean; error?: boolean; lanes?: unknown[]; pending?: unknown[]; discardable?: string[]; mergeable?: Record<string, unknown>; merged?: string[] }
export interface Room {
  folder: string; agents: string[]; worker: string; workerModel: string | null;
  cliSessions: unknown; discussion: string; active: string | null; started: boolean;
  fresh: boolean; brainstorm: boolean; workbench: boolean; research: boolean;
  workbenches: string[]; researches: string[]; researchStats: unknown; members: unknown[];
  failedAgents: { name: string; disabled: boolean }[]; autoDev: { status: string | null; [key: string]: unknown } | null; workerStop: unknown;
  retryId: string | null; transcript: string | null; checkpoints: unknown; closedDiscussions: unknown;
  closingDiscussions: Record<string, string>; busyWorkers: string[]; back: unknown; code: unknown;
  rollbacks: unknown[]; multi: unknown; open: unknown;
}
export type Monitor = Record<string, { login: unknown; running: number; leftovers: unknown[]; inRoom: boolean }>;
export interface Replica { node: string; addresses: string[]; roomId: string; project: string | null; own: Record<string, unknown>; received: unknown[]; peers: unknown[] }
export interface ResetEvent {
  type: 'reset'; messages: MessageView[]; doc?: string | null; thinking?: string | null;
  status?: string | null; busy: boolean; input: boolean; room: Room | null; worker: WorkerMessage[];
  working: string | null; workInput: boolean; workerInfo: WorkerInfo | null;
  quota?: Gauge[] | null; quotaAt: QuotaAt | null; monitor: Monitor | null; newRoom: boolean;
  page: string; webVersion: string | null; replica: Replica | null; replicaOff: string | null; viewing: unknown; peek: Peek | null;
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
  replica?: Replica | null; replicaOff?: string | null; viewing?: unknown; peek?: Peek | null;
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
