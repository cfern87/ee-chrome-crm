import React from 'react';
import ReactDOM from 'react-dom/client';
import DashboardApp from './DashboardApp';
import { installUiStylesheet } from '../ui/stylesheet';

// Before the first render: the design tokens and the rules that inline styles
// can't express (:hover, :focus-visible, ::placeholder). Injected rather than
// linked so the dashboard and the injected Messenger panel share one copy of
// the values instead of two that drift.
installUiStylesheet();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DashboardApp />
  </React.StrictMode>
);
