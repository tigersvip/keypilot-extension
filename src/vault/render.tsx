import React from 'react';
import ReactDOM from 'react-dom/client';
import { VaultApp } from './VaultApp';
import '../styles/vault.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <VaultApp />
  </React.StrictMode>
);
