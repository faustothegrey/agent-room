import type { CSSProperties } from 'react';
import type { MessageView } from '../../src/contract.d.ts';
import characterSheet from './office-assets/CharacterModel.png?inline';
import hairSheet from './office-assets/Hairs.png?inline';
import shadowSheet from './office-assets/Shadow.png?inline';
import suitSheet from './office-assets/Suit.png?inline';
import suit1Sheet from './office-assets/Suit1.png?inline';
import './office.css';

export type AgentOfficeState = 'speaking' | 'passed' | 'waiting' | 'failed' | 'round-ended';
type Facing = 'down' | 'right' | 'up' | 'left';

// MetroCity stock idle columns (24 cols of 32x32, 6 frames per direction: down, right, up, left).
const FACING_COL: Record<Facing, number> = { down: 0, right: 6, up: 12, left: 18 };
const TILE = 64; // 32px native sprite rendered at 2x with image-rendering: pixelated

function hashName(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Compute which agents passed in the current round:
// last message from each agent since the last User message has pass: true.
export function computePassedAgents(messages: Pick<MessageView, 'speaker' | 'pass'>[]): string[] {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].speaker === 'User') { start = i + 1; break; }
  }
  const latest = new Map<string, boolean>();
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (m.speaker && m.speaker !== 'User') latest.set(m.speaker, !!m.pass);
  }
  return [...latest.entries()].filter(([, passed]) => passed).map(([speaker]) => speaker);
}

function sheetStyle(src: string, rows: number, col: number, row: number): CSSProperties {
  return {
    backgroundImage: `url("${src}")`,
    backgroundSize: `${24 * TILE}px ${rows * TILE}px`,
    backgroundPosition: `${-col * TILE}px ${-row * TILE}px`,
  };
}

function CharacterSprite({ name, facing, worker = false, motion = 'none' }: {
  name: string; facing: Facing; worker?: boolean; motion?: 'none' | 'bob' | 'hammer';
}) {
  const col = FACING_COL[facing];
  const h = hashName(name);
  const bodyRow = worker ? 2 : h % 6;
  const outfitRow = h % 5;
  const hairRow = (h >>> 3) % 8;
  return (
    <div
      className={'office-sprite' + (motion === 'bob' ? ' bob' : motion === 'hammer' ? ' hammer' : '')}
      aria-hidden="true"
    >
      <span
        className="office-sprite-layer"
        style={{ backgroundImage: `url("${shadowSheet}")`, backgroundSize: `${TILE}px ${TILE}px` }}
      />
      <span className="office-sprite-layer" style={sheetStyle(characterSheet, 6, col, bodyRow)} />
      {worker ? (
        // Suit.png row 3: orange cap + orange vest
        <span className="office-sprite-layer" style={sheetStyle(suitSheet, 4, col, 3)} />
      ) : (
        <>
          <span className="office-sprite-layer" style={sheetStyle(suit1Sheet, 5, col, outfitRow)} />
          <span className="office-sprite-layer" style={sheetStyle(hairSheet, 8, col, hairRow)} />
        </>
      )}
    </div>
  );
}

export interface OfficeProps {
  boardTitle: string;
  agents: string[];
  workerName: string;
  thinking: string | null;
  working: string | null;
  passedAgents: string[];
  failedAgents: string[];
  roundEnded: boolean;
  workbench?: boolean;
}

export function Office({
  boardTitle,
  agents,
  workerName,
  thinking,
  working,
  passedAgents,
  failedAgents,
  roundEnded,
  workbench = false,
}: OfficeProps) {
  const participants = workbench ? [] : agents;
  const passedSet = new Set(passedAgents);
  const failedSet = new Set(failedAgents);
  const workerBusy = !!working;

  const agentStates = participants.map((name) => {
    let state: AgentOfficeState;
    if (failedSet.has(name)) state = 'failed';
    else if (thinking === name) state = 'speaking';
    else if (roundEnded && !thinking) state = 'round-ended';
    else if (passedSet.has(name)) state = 'passed';
    else state = 'waiting';
    const facing: Facing =
      state === 'round-ended' ? 'down'
        : state === 'failed' ? (roundEnded ? 'down' : 'up')
          : state === 'passed' ? 'down'
            : 'up';
    return { name, state, facing };
  });

  const atCoffee = agentStates.filter((a) => a.state === 'passed');
  const awaitingDoor = participants.length > 0 && roundEnded && !thinking;

  const summary = participants.length === 0
    ? (workerBusy ? `${workerName} hammering` : 'Workbench idle')
    : thinking
      ? `${thinking} typing…`
      : awaitingDoor
        ? 'Your turn · facing door'
        : 'Round in progress';

  return (
    <section className="office-panel" aria-label="Office">
      <div className="office-header">
        <span className="office-board-name" title={boardTitle}>{boardTitle || 'Office'}</span>
        <span className="office-summary">{summary}</span>
      </div>

      <div className="office-room" data-round-ended={awaitingDoor ? 'true' : 'false'}>
        <div className="office-wall">
          <div className="office-window" aria-hidden="true" />
          <span className="office-plaque">{workbench ? 'Workshop' : 'Agent Room'}</span>
          <div className="office-window" aria-hidden="true" />
        </div>

        <div className="office-floor">
          {participants.length > 0 && (
            <div className="office-desks" aria-label="Agent desks">
              {agentStates.map(({ name, state, facing }) => {
                const screenState =
                  state === 'failed' ? 'failed'
                    : state === 'speaking' ? 'lit'
                      : state === 'passed' ? 'off'
                        : 'dim';
                return (
                  <div
                    key={name}
                    className="office-desk"
                    data-agent={name}
                    data-state={state}
                    data-facing={facing}
                  >
                    {state === 'speaking' && <span className="office-bubble">typing…</span>}
                    {state === 'waiting' && <span className="office-zzz" aria-label={`${name} waiting`}>z z</span>}
                    {state === 'failed' && <span className="office-boom" aria-label={`${name} failed`}>💥</span>}
                    <div className="office-desk-top">
                      <div className={`office-monitor screen-${screenState}`} data-screen={screenState} />
                    </div>
                    <div className="office-desk-slot">
                      {state === 'passed' ? (
                        <div className="office-empty-chair" title={`${name} is at the coffee spot`} />
                      ) : (
                        <CharacterSprite
                          name={name}
                          facing={facing}
                          motion={state === 'speaking' ? 'bob' : 'none'}
                        />
                      )}
                    </div>
                    <span className="office-name" title={name}>{name}</span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="office-stations">
            <div
              className={'office-workbench' + (workerBusy ? ' working' : '') + (participants.length === 0 ? ' solo' : '')}
              data-worker={workerName}
              data-state={workerBusy ? 'working' : 'idle'}
              data-facing={workerBusy ? 'up' : 'down'}
              aria-label="Workbench"
            >
              <span className="office-station-label">Workbench</span>
              <div className="office-bench-top" aria-hidden="true">
                <span>🔧</span>
                <span>🪛</span>
              </div>
              <div className="office-worker-stage">
                {workerBusy && <span className="office-sparks" aria-label="Worker hammering">🔨✨</span>}
                <CharacterSprite
                  name={workerName}
                  facing={workerBusy ? 'up' : 'down'}
                  worker
                  motion={workerBusy ? 'hammer' : 'none'}
                />
                <span className="office-name" title={workerName}>{workerName}</span>
                <span className="office-worker-state">{workerBusy ? 'hammering…' : 'idle'}</span>
              </div>
            </div>

            {participants.length > 0 && (
              <div className="office-coffee" aria-label="Coffee spot">
                <span className="office-station-label">Coffee spot</span>
                <div className="office-coffee-bar" aria-hidden="true">
                  <div className="office-machine" />
                  <span>☕</span>
                </div>
                <div className="office-coffee-guests">
                  {atCoffee.length === 0 ? (
                    <span className="office-coffee-empty">Fresh pot ready</span>
                  ) : (
                    atCoffee.map(({ name }) => (
                      <div
                        key={name}
                        className="office-coffee-guest"
                        data-coffee-agent={name}
                        data-state="passed"
                        data-facing="down"
                      >
                        <span className="office-steam" aria-hidden="true">~ ~</span>
                        <span className="office-mug" aria-label={`${name} with steaming mug`}>☕</span>
                        <CharacterSprite name={name} facing="down" />
                        <span className="office-name" title={name}>{name}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="office-door-wall">
          <div className={'office-door' + (awaitingDoor ? ' awaiting' : '')} aria-label="Door">
            <span>{awaitingDoor ? 'Your turn' : 'Door'}</span>
          </div>
        </div>
      </div>

      <div className="office-legend" aria-hidden="true">
        <span>💬 typing</span>
        <span>☕ passed</span>
        <span>z z waiting</span>
        <span>💥 failed</span>
        <span>🚪 your turn</span>
        <span>🔨 worker</span>
      </div>
    </section>
  );
}
