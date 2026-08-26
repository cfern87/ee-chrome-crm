// Cross-machine dismissal of the failed-send notice.
//
// The reported failure: 79 failed sends were cleared on one machine and every
// one of them was still sitting on the other. Campaign history syncs, so both
// machines saw the same failures; what didn't sync was the fact that a human
// had already dealt with them.
//
// Written as ROUNDS of the real merge cycle, like settingsMerge.test.ts, for
// the same reason given there: a merge that keeps this machine's copy looks
// fine in isolation and is only wrong once the other machine does the same in
// reverse. A dismissal that survives one round but is undone on the next is
// exactly what the user saw.

import { describe, it, expect } from 'vitest';
import { mergeSettings, mergeSettingsWithBase, reconcileCollections, type SettingsBag } from './settingsMerge';
import {
  writeFailedNoticeAck, writeClearedFailures, noticeAckIn, clearedFailureKeysIn,
  collectUnseenFailures, failureKey, FAILED_NOTICE_ACK_KEY,
  type Campaign,
} from './campaigns';
import { EMPTY_STORE, type Store } from './storage';

const storeWith = (settings: SettingsBag): Store => ({ ...EMPTY_STORE, settings });

/** Drive mode: two copies, no ancestor. Argument order is mergeStores'. */
const driveRound = (remote: SettingsBag, local: SettingsBag, now?: number): SettingsBag =>
  mergeSettings(remote, local, now);

const syncRound = (base: SettingsBag, mine: SettingsBag, theirs: SettingsBag, now?: number): SettingsBag =>
  mergeSettingsWithBase(base, mine, theirs, now);

const keysIn = (s: SettingsBag) => clearedFailureKeysIn(storeWith(s)).sort();

describe('the dismiss-everything watermark', () => {
  it('survives a machine that never dismissed anything — the reported bug', () => {
    // Laptop clears 79 failures at t=5000.
    const laptop = writeFailedNoticeAck({}, 5_000);
    // Desktop hasn't been opened in a week and holds an older ack.
    const desktop = writeFailedNoticeAck({}, 1_000);

    // Desktop syncs. Under plain scalar rules the local machine wins outright
    // in Drive mode, which is what put all 79 notices back.
    const onDesktop = driveRound(laptop, desktop);
    expect(onDesktop[FAILED_NOTICE_ACK_KEY]).toBe(5_000);

    // And the laptop syncing against what the desktop just published keeps it.
    const backOnLaptop = driveRound(onDesktop, laptop);
    expect(backOnLaptop[FAILED_NOTICE_ACK_KEY]).toBe(5_000);
  });

  it('settles instead of ping-ponging across repeated rounds', () => {
    let laptop = writeFailedNoticeAck({}, 5_000);
    let desktop = writeFailedNoticeAck({}, 1_000);

    for (let i = 0; i < 3; i++) {
      desktop = driveRound(laptop, desktop);
      laptop = driveRound(desktop, laptop);
    }

    expect(noticeAckIn(storeWith(laptop))).toBe(5_000);
    expect(noticeAckIn(storeWith(desktop))).toBe(5_000);
  });

  it('holds in legacy sync mode too, where the bag is one item', () => {
    const base = { [FAILED_NOTICE_ACK_KEY]: 1_000, pace: 5 };
    // This machine is saving an unrelated setting while sync already carries a
    // newer ack from elsewhere.
    const mine = { [FAILED_NOTICE_ACK_KEY]: 1_000, pace: 30 };
    const theirs = { [FAILED_NOTICE_ACK_KEY]: 5_000, pace: 5 };

    const out = syncRound(base, mine, theirs);
    expect(out[FAILED_NOTICE_ACK_KEY]).toBe(5_000);
    expect(out.pace).toBe(30);
  });

  it('never moves backwards, even when told to', () => {
    // A stale tab writing an older stamp must not un-dismiss anything.
    const after = writeFailedNoticeAck(writeFailedNoticeAck({}, 5_000), 1_000);
    expect(after[FAILED_NOTICE_ACK_KEY]).toBe(5_000);
  });

  it('leaves a bag that has no watermark alone', () => {
    expect(driveRound({ pace: 5 }, { pace: 5 })).toEqual({ pace: 5 });
  });
});

describe('individually-cleared failures', () => {
  it('carries a dismissal to the other machine', () => {
    const laptop = writeClearedFailures({}, ['c1|t1|100'], 5_000);
    const desktop: SettingsBag = {};

    expect(keysIn(driveRound(laptop, desktop))).toEqual(['c1|t1|100']);
  });

  it('keeps dismissals made independently on both machines', () => {
    // The point of a per-record merge: clearing this person here and that
    // person there are two changes, not two answers to one question.
    const laptop = writeClearedFailures({}, ['c1|t1|100'], 5_000);
    const desktop = writeClearedFailures({}, ['c1|t2|200'], 5_100);

    expect(keysIn(driveRound(laptop, desktop))).toEqual(['c1|t1|100', 'c1|t2|200']);
    expect(keysIn(driveRound(desktop, laptop))).toEqual(['c1|t1|100', 'c1|t2|200']);
  });

  it('does not resurrect a dismissal after both machines have converged', () => {
    let laptop = writeClearedFailures({}, ['c1|t1|100'], 5_000);
    let desktop: SettingsBag = {};

    for (let i = 0; i < 3; i++) {
      desktop = driveRound(laptop, desktop);
      laptop = driveRound(desktop, laptop);
    }

    expect(keysIn(laptop)).toEqual(['c1|t1|100']);
    expect(keysIn(desktop)).toEqual(['c1|t1|100']);
  });

  it('does not re-stamp a dismissal that is merely re-saved', () => {
    // Re-stamping the whole list on every save would make an untouched record
    // outrank a genuine change to it elsewhere.
    const first = writeClearedFailures({}, ['c1|t1|100'], 5_000);
    const again = writeClearedFailures(first, ['c1|t1|100', 'c1|t2|200'], 9_000);
    const records = again.clearedFailures as { id: string; at: number }[];

    expect(records.find((r) => r.id === 'c1|t1|100')!.at).toBe(5_000);
    expect(records.find((r) => r.id === 'c1|t2|200')!.at).toBe(9_000);
  });

  it('reads a pre-sync bag that still holds bare key strings', () => {
    // What an older build wrote, or an old backup restore.
    expect(clearedFailureKeysIn(storeWith({ clearedFailures: ['c1|t1|100'] }))).toEqual(['c1|t1|100']);
  });

  it('dates an undated pre-sync record on first write, so it can age out later', () => {
    // Left undated it would be both immortal and outranked by every other copy.
    const out = writeClearedFailures({ clearedFailures: ['c1|t1|100'] }, ['c1|t1|100'], 5_000);
    expect(out.clearedFailures).toEqual([{ id: 'c1|t1|100', at: 5_000 }]);
  });

  it('drops a dismissal once it ages out', () => {
    const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
    const old = writeClearedFailures({}, ['c1|t1|100'], 1_000);
    const later = writeClearedFailures(old, ['c1|t1|100'], 1_000 + NINETY_DAYS + 1);
    expect(keysIn(later)).toEqual([]);
  });

  it('survives the legacy load path, where sync is canonical', () => {
    // A dismissal that reached the local cache but not sync must not be lost by
    // a read — that path deliberately lets sync win the scalars.
    const canonical: SettingsBag = {};
    const local = writeClearedFailures({}, ['c1|t1|100'], 5_000);
    expect(keysIn(reconcileCollections(canonical, local))).toEqual(['c1|t1|100']);
  });
});

describe('what the notice actually shows after a sync', () => {
  function campaignWithFailures(count: number): Campaign[] {
    return [{
      id: 'c1',
      name: 'Outreach',
      message: '',
      status: 'completed',
      createdAt: 0,
      updatedAt: 0,
      recipients: Array.from({ length: count }, (_, i) => ({
        threadId: `t${i}`,
        participantName: `Person ${i}`,
        status: 'error' as const,
        failedAt: 1_000 + i,
      })),
    } as unknown as Campaign];
  }

  it('a dismiss-all on one machine empties the notice on the other', () => {
    const campaigns = campaignWithFailures(79);

    // Before: the desktop sees all 79.
    const desktopBefore = storeWith({});
    expect(collectUnseenFailures(campaigns, noticeAckIn(desktopBefore), new Set())).toHaveLength(79);

    // The laptop dismisses everything, and the desktop syncs.
    const laptop = writeFailedNoticeAck({}, 9_999);
    const desktopAfter = storeWith(driveRound(laptop, {}));

    expect(collectUnseenFailures(campaigns, noticeAckIn(desktopAfter), new Set())).toHaveLength(0);
  });

  it('a single cleared failure disappears on the other machine, and only that one', () => {
    const campaigns = campaignWithFailures(3);
    const key = failureKey({ campaignId: 'c1', threadId: 't1', failedAt: 1_001 });

    const laptop = writeClearedFailures({}, [key], 5_000);
    const desktop = storeWith(driveRound(laptop, {}));

    const unseen = collectUnseenFailures(campaigns, 0, new Set(clearedFailureKeysIn(desktop)));
    expect(unseen.map((f) => f.threadId).sort()).toEqual(['t0', 't2']);
  });
});
