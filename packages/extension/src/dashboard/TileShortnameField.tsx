// The "Short name" field on both tile editors (Edit query, Edit formula).
//
// Shows the tile's id beside it, because the point of a short name is to be
// linked to that id in the daily report: a reader of the report sees both.

import React from 'react';
import { SHORTNAME_MAX } from '../dashboardTiles';
import { Input, Text, color, space } from '../ui/primitives';

export function TileShortnameField({
  value, onChange, tileId, problem, onEnter,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The tile's id, or null for a tile that gets one when it is saved. */
  tileId: string | null;
  /** Why the value can't be saved, if it can't. */
  problem: string | null;
  onEnter?: () => void;
}) {
  return (
    <div data-shortname-field style={{ marginBottom: 14, maxWidth: 360 }}>
      <Input
        value={value}
        aria-label="Short name"
        invalid={!!problem}
        maxLength={SHORTNAME_MAX}
        placeholder="Short name for reports (optional, e.g. hot_leads)"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && onEnter) onEnter(); }}
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}
      />
      {problem ? (
        <div role="alert" style={{ fontSize: 11, color: color.danger.base, marginTop: space.xs }}>{problem}</div>
      ) : (
        <Text as="div" size="small" tone="muted" style={{ marginTop: space.xs }}>
          Sent with this tile in the daily report, next to its id
          {tileId ? <> <code data-tile-id-label>{tileId}</code></> : ' (assigned when the tile is saved)'}.
        </Text>
      )}
    </div>
  );
}
