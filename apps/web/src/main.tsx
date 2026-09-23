import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './EktSite';
import './styles.css';
import './assistant-overrides.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
