import React from 'react';
import ReactDOM from 'react-dom/client';
import DashboardApp from './DashboardApp';
import { installUiStylesheet } from '../ui/stylesheet';

// Before the first render: the design tokens and the rules that inline styles
// can't express (:hover, :focus-visible, ::placeholder). Injected rather than
// linked so the dashboard and the injected Messenger panel share one copy of
// the values instead of two that drift.
// `pageReset` because the dashboard owns this page outright — the shell is
// exactly one viewport tall, which body's default 8px margin would otherwise
// turn into 16px of overflow and an unwanted scrollbar.
installUiStylesheet({ pageReset: true });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DashboardApp />
  </React.StrictMode>
);
