import { useEffect, useState } from 'react';
import type { MessageView, ScreenEvent } from '../../src/contract';

type Props = { version: string | undefined; refresh: () => void };

export function App({ version, refresh }: Props) {
  const [title, setTitle] = useState('agent-room');
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [thinking, setThinking] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const events = new EventSource('__events');
    events.onmessage = ({ data }) => {
      const event = JSON.parse(data) as ScreenEvent;
      if ('webVersion' in event && event.webVersion && version && event.webVersion !== version) {
        refresh();
        return;
      }
      if (event.type === 'reset') {
        setTitle(event.room?.discussion ?? 'agent-room');
        setMessages(event.messages.filter((m) => !m.pass && !m.hidden));
        setThinking(event.thinking ?? null);
        setStatus(event.status ?? null);
      } else if (event.type === 'message') {
        if (!event.message.pass && !event.message.hidden) setMessages((previous) => [...previous, event.message]);
      } else if (event.type === 'thinking') {
        setThinking(event.name);
        if (event.name) setStatus(null);
      } else if (event.type === 'turn') {
        setThinking(null);
        setStatus(event.text);
      } else if (event.type === 'room') {
        setTitle(event.room.discussion);
      }
    };
    return () => events.close();
  }, [version, refresh]);

  return <main>
    <h1>{title}</h1>
    <section aria-label="Conversation">{messages.map((message, index) => <article key={index}>
      <strong>{message.speaker}</strong><div dangerouslySetInnerHTML={{ __html: message.html }} />
    </article>)}</section>
    {thinking && <p>{thinking} is thinking…</p>}
    {status && <p>{status}</p>}
  </main>;
}
