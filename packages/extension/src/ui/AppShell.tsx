// The application frame: a left rail, a slim top bar, and a notifications
// drawer.
//
// This replaces two things. The first was a 20px-tall blue gradient banner
// carrying a title and two numbers. The second was a six-tab strip that put
// Conversations (a workspace), Messaging (a composer), History (a log), Tags
// and Fields (schema) and Settings (config) on one row as equals — three
// different altitudes presented as peers, which is most of why the app read as
// assembled rather than designed.
//
// The rail also fixes the proportions complaint at its root. The old layout
// centred everything in a 1100px column, so on a wide monitor the contact list
// was pinned at 320px, the detail pane got about 766px, and the rest of the
// screen was empty grey. A shell that owns the full viewport gives Phase 3 room
// to make those columns fluid.

import React, { useCallback, useEffect, useRef } from 'react';
import { color, fontSize, fontWeight, radius, space, elevation } from './tokens';
import { Icon, Text, IconButton } from './primitives';
import { ICON_BELL, ICON_CHEVRON, ICON_CLOSE } from './icons';
import { PRODUCT_NAME } from '../product';

export interface NavItem<Id extends string = string> {
  id: Id;
  label: string;
  /** Inner markup from ui/icons.ts. */
  icon: string;
  /** Shown after the label — a count of what's inside. */
  count?: number;
}

export interface AppShellProps<Id extends string = string> {
  nav: NavItem<Id>[];
  activeId: Id;
  onNavigate: (id: Id) => void;

  /** Collapsed rail shows icons only. Persisted by the caller. */
  railCollapsed: boolean;
  onToggleRail: () => void;

  /** Name of the current destination, shown in the top bar. */
  title: string;
  /** Compact counts, replacing the old stat-tile row. */
  meta?: React.ReactNode;
  /** Right-hand side of the top bar, before the bell. */
  actions?: React.ReactNode;

  /**
   * Whether the shell scrolls the content area. False for routes that manage
   * their own scrolling — the Contacts workspace scrolls its list and its
   * detail pane independently, and an outer scroller would fight both.
   */
  contentScroll?: boolean;

  /** Drawer contents. When absent the bell is still shown, with an empty state. */
  notifications?: React.ReactNode;
  notificationCount?: number;
  drawerOpen: boolean;
  onDrawerOpenChange: (open: boolean) => void;

  children: React.ReactNode;
}

const RAIL_WIDE = 208;
const RAIL_NARROW = 60;
const TOPBAR_HEIGHT = 52;

export function AppShell<Id extends string>({
  nav, activeId, onNavigate,
  railCollapsed, onToggleRail,
  title, meta, actions,
  contentScroll = true,
  notifications, notificationCount = 0, drawerOpen, onDrawerOpenChange,
  children,
}: AppShellProps<Id>) {
  const bellRef = useRef<HTMLButtonElement>(null);

  return (
    <div
      className="crm-root"
      style={{
        // The whole app is exactly one viewport tall and never scrolls itself.
        // Scrolling belongs to the panes inside, which is what stops the list
        // and the detail pane fighting over who moves.
        height: '100vh',
        display: 'grid',
        gridTemplateColumns: `${railCollapsed ? RAIL_NARROW : RAIL_WIDE}px 1fr`,
        gridTemplateRows: '100%',
        overflow: 'hidden',
      }}
    >
      <Rail
        nav={nav}
        activeId={activeId}
        onNavigate={onNavigate}
        collapsed={railCollapsed}
        onToggle={onToggleRail}
      />

      <div style={{ display: 'grid', gridTemplateRows: `${TOPBAR_HEIGHT}px 1fr`, minWidth: 0, minHeight: 0 }}>
        <TopBar
          title={title}
          meta={meta}
          actions={actions}
          bellRef={bellRef}
          notificationCount={notificationCount}
          onOpenDrawer={() => onDrawerOpenChange(true)}
        />

        <main
          style={{
            minWidth: 0,
            minHeight: 0,
            overflow: contentScroll ? 'auto' : 'hidden',
            background: color.surface.page,
          }}
        >
          {children}
        </main>
      </div>

      {drawerOpen && (
        <Drawer
          title="Notifications"
          onClose={() => onDrawerOpenChange(false)}
          returnFocusTo={bellRef}
        >
          {notifications}
        </Drawer>
      )}
    </div>
  );
}

// --- Rail -----------------------------------------------------------------

function Rail<Id extends string>({
  nav, activeId, onNavigate, collapsed, onToggle,
}: {
  nav: NavItem<Id>[];
  activeId: Id;
  onNavigate: (id: Id) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <nav
      aria-label="Sections"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: space.xxs,
        padding: space.sm,
        background: color.surface.raised,
        borderRight: `1px solid ${color.border.subtle}`,
        minHeight: 0,
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex', alignItems: 'flex-start', gap: space.sm,
          padding: `${space.xs}px ${space.sm}px ${space.md}px`,
        }}
      >
        <span aria-hidden="true" style={{ fontSize: fontSize.title, lineHeight: 1.1 }}>🏷️</span>
        {!collapsed && (
          // Wraps rather than truncating. There is one product name and this is
          // it — an abbreviation here is what let four different names grow in
          // the first place.
          <Text size="body" weight="bold" leading="tight">{PRODUCT_NAME}</Text>
        )}
      </div>

      {nav.map((item) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item.id)}
            aria-current={active ? 'page' : undefined}
            title={collapsed ? item.label : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: space.md,
              width: '100%',
              minHeight: 38,
              padding: `0 ${space.md}px`,
              border: 'none',
              borderRadius: radius.sm,
              background: active ? color.accent.subtle : 'transparent',
              color: active ? color.accent.base : color.text.secondary,
              font: 'inherit',
              fontWeight: active ? fontWeight.semibold : fontWeight.medium,
              cursor: 'pointer',
              justifyContent: collapsed ? 'center' : undefined,
            }}
          >
            <Icon paths={item.icon} />
            {!collapsed && (
              <>
                <span style={{ flex: 1, textAlign: 'left', whiteSpace: 'nowrap' }}>{item.label}</span>
                {item.count !== undefined && (
                  <Text size="micro" weight="semibold" tone={active ? 'accent' : 'muted'}>{item.count}</Text>
                )}
              </>
            )}
          </button>
        );
      })}

      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        style={{
          display: 'flex', alignItems: 'center', gap: space.md,
          marginTop: 'auto', minHeight: 34, padding: `0 ${space.md}px`,
          border: 'none', borderRadius: radius.sm, background: 'transparent',
          color: color.text.muted, font: 'inherit', fontSize: fontSize.small,
          cursor: 'pointer', justifyContent: collapsed ? 'center' : undefined,
        }}
      >
        <Icon paths={ICON_CHEVRON} size={14} style={{ transform: collapsed ? 'none' : 'rotate(180deg)' }} />
        {!collapsed && <span>Collapse</span>}
      </button>
    </nav>
  );
}

// --- Top bar --------------------------------------------------------------

function TopBar({
  title, meta, actions, bellRef, notificationCount, onOpenDrawer,
}: {
  title: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  bellRef: React.RefObject<HTMLButtonElement>;
  notificationCount: number;
  onOpenDrawer: () => void;
}) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: space.md,
        padding: `0 ${space.lg}px`,
        background: color.surface.raised,
        borderBottom: `1px solid ${color.border.subtle}`,
        minWidth: 0,
      }}
    >
      <Text as="div" size="strong" weight="bold" style={{ whiteSpace: 'nowrap' }}>{title}</Text>
      {meta && (
        <div
          className="crm-topbar__meta"
          style={{ display: 'flex', alignItems: 'center', gap: space.md, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}
        >
          {meta}
        </div>
      )}

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: space.sm }}>
        {actions}
        <button
          ref={bellRef}
          type="button"
          onClick={onOpenDrawer}
          aria-label={
            notificationCount > 0
              ? `Notifications, ${notificationCount} needing attention`
              : 'Notifications'
          }
          title="Notifications"
          style={{
            position: 'relative',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 34, height: 34,
            border: `1px solid ${notificationCount > 0 ? color.danger.base : 'transparent'}`,
            borderRadius: radius.sm,
            background: notificationCount > 0 ? color.danger.subtle : 'transparent',
            color: notificationCount > 0 ? color.danger.base : color.text.secondary,
            cursor: 'pointer',
          }}
        >
          <Icon paths={ICON_BELL} />
          {notificationCount > 0 && (
            <span
              aria-hidden="true"
              style={{
                position: 'absolute', top: -6, right: -6,
                minWidth: 18, height: 18, padding: '0 5px',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: radius.pill,
                background: color.danger.base, color: color.danger.onBase,
                fontSize: fontSize.micro, fontWeight: fontWeight.bold, lineHeight: 1,
              }}
            >
              {notificationCount > 99 ? '99+' : notificationCount}
            </span>
          )}
        </button>
      </div>
    </header>
  );
}

// --- Drawer ---------------------------------------------------------------

/**
 * A right-hand sheet. Escape closes it, focus moves inside on open and returns
 * to whatever opened it on close, and the scrim is inert to the pointer only
 * insofar as clicking it closes.
 *
 * Focus is moved but not trapped: everything behind is inert to the keyboard
 * only in the sense that tabbing past the end lands back in the page. A full
 * trap would need a focus sentinel pair, which is more machinery than a
 * notifications list warrants — Escape and the close button are both one
 * keystroke away at all times.
 */
function Drawer({
  title, onClose, returnFocusTo, children,
}: {
  title: string;
  onClose: () => void;
  returnFocusTo: React.RefObject<HTMLElement>;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    onClose();
    // Put focus back where it came from, or the user is dumped at the top of
    // the document with no idea where they are.
    window.setTimeout(() => returnFocusTo.current?.focus(), 0);
  }, [onClose, returnFocusTo]);

  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <>
      <div
        onClick={close}
        style={{ position: 'fixed', inset: 0, background: 'rgba(16,24,40,0.32)', zIndex: 40 }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0,
          width: 'min(420px, 100vw)',
          display: 'flex', flexDirection: 'column',
          background: color.surface.page,
          borderLeft: `1px solid ${color.border.subtle}`,
          boxShadow: elevation.lg,
          zIndex: 41,
        }}
      >
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: space.sm,
            padding: `${space.md}px ${space.lg}px`,
            background: color.surface.raised,
            borderBottom: `1px solid ${color.border.subtle}`,
          }}
        >
          <Text size="strong" weight="bold">{title}</Text>
          <div style={{ marginLeft: 'auto' }}>
            <IconButton label="Close notifications" onClick={close}>
              <Icon paths={ICON_CLOSE} size={14} />
            </IconButton>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: space.lg }}>
          {children}
        </div>
      </div>
    </>
  );
}
