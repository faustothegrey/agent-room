import { createRoot } from 'react-dom/client';
import { App } from './App';

const version = document.querySelector<HTMLMetaElement>('meta[name="agent-room-next-version"]')?.content;
const refresh = () => location.reload();
createRoot(document.getElementById('root')!).render(<App version={version} refresh={refresh} />);
