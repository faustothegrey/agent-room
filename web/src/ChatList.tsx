import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

// A chat list that follows new content while it is already at the bottom (within 40 px), and
// offers a ↓ button to jump to the end otherwise, as makeChat does on /__room. Whether the list
// follows is decided by where it was before the change: by the last scroll, or a resize of the
// list itself. A new resetKey (a reset event cleared it) starts at the bottom again.
const atBottom = (list: HTMLElement) => list.scrollHeight - list.scrollTop - list.clientHeight < 40;
export function ChatList({ endLabel, resetKey, children }: { endLabel: string; resetKey: number; children: ReactNode }) {
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true), lastReset = useRef(resetKey);
  const [endHidden, setEndHidden] = useState(true);
  const updateEnd = () => { const el = list.current; if (el) setEndHidden(atBottom(el)); };
  useEffect(() => {
    const el = list.current; if (!el) return;
    const onScroll = () => { stick.current = atBottom(el); updateEnd(); };
    el.addEventListener('scroll', onScroll);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onScroll);
    observer?.observe(el);
    return () => { el.removeEventListener('scroll', onScroll); observer?.disconnect(); };
  }, []);
  useLayoutEffect(() => {
    const el = list.current; if (!el) return;
    if (lastReset.current !== resetKey) { lastReset.current = resetKey; stick.current = true; }
    if (stick.current) el.scrollTop = el.scrollHeight;
    updateEnd();
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
