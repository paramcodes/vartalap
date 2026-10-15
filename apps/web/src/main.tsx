import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from './shell.tsx';
import './theme.css';

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
