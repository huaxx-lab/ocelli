/**
 * main.tsx — the standalone Avatar Lab entry point.
 *
 * Two ways to reach the Lab:
 *   1. Standalone dev page (this file) — Vite serves it at `/avatar-lab.html`,
 *      which is the fastest iteration loop while tuning the animation.
 *   2. Inside the DSH Web GUI at `/avatar-lab` — the Cordis plugin mounts the
 *      exact same `<AvatarLab />` component into a `shell.overlay` entry.
 *
 * Both paths render the same component, so there is exactly one Lab to keep
 * working.
 */

import { createRoot } from 'react-dom/client';
import { AvatarLab } from './avatar/components/AvatarLab';
import './lab/lab.css';

const container = document.getElementById('root');
if (!container) throw new Error('avatar-lab: #root container missing');
createRoot(container).render(<AvatarLab />);
