import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

// A chat list that follows new content while it is already at the bottom (within 40 px), and
// offers a ↓ button to jump to the end otherwise, as makeChat does on /__room. Whether the list
// follows is decided by where it was before the change: by the last scroll, or a resize of the
// list itself. A new resetKey (a reset event cleared it) starts at the bottom again.
// A list that leaves the page (the Worker tab while Discussion is shown) keeps its place in
// `memory`, so coming back shows it where it was, as the hidden list does on /__room.
export type ChatMemory = { top: number; stick: boolean; reset: number };
const atBottom = (list: HTMLElement) => list.scrollHeight - list.scrollTop - list.clientHeight < 40;
export function ChatList({ endLabel, resetKey, memory, children }: { endLabel: string; resetKey: number; memory?: RefObject<ChatMemory | null>; children: ReactNode }) {
  const list = useRef<HTMLDivElement>(null);
  const saved = memory?.current, restored = useRef(!!saved && saved.reset === resetKey && !saved.stick);
  const stick = useRef(restored.current ? false : true), lastReset = useRef(resetKey);
  const remember = (el: HTMLElement) => { if (memory) memory.current = { top: el.scrollTop, stick: stick.current, reset: lastReset.current }; };
  const [endHidden, setEndHidden] = useState(true);
  const updateEnd = () => { const el = list.current; if (el) setEndHidden(atBottom(el)); };
  useEffect(() => {
    const el = list.current; if (!el) return;
    const onScroll = () => { stick.current = atBottom(el); updateEnd(); remember(el); };
    el.addEventListener('scroll', onScroll);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onScroll);
    observer?.observe(el);
    return () => { el.removeEventListener('scroll', onScroll); observer?.disconnect(); };
  }, []);
  useLayoutEffect(() => {
    const el = list.current; if (!el) return;
    if (lastReset.current !== resetKey) { lastReset.current = resetKey; stick.current = true; }
    if (restored.current && saved) { restored.current = false; el.scrollTop = saved.top; }
    else if (stick.current) el.scrollTop = el.scrollHeight;
    updateEnd(); remember(el);
  });
  const toEnd = () => {
    const el = list.current; if (!el) return;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior: reduced ? 'instant' : 'smooth' });
    else el.scrollTop = el.scrollHeight;
  };
  return <div className="chat-wrap">
    <div ref={list} className="chat">{children}</div>
    <button type="button" className="scroll-end" aria-label={endLabel} title="Scroll to latest messages" hidden={endHidden} onClick={toEnd}>↓</button>
  </div>;
}
