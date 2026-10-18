// Searching and archiving campaign history.

import { describe, it, expect } from 'vitest';
import {
  campaignMatchesQuery, matchingRecipients, failedRecipients, collectUnseenFailures,
  failureReport, capLog, MAX_LOG_LINES,
  type Campaign, type CampaignRecipient,
} from './campaigns';

function recipient(name: string, over: Partial<CampaignRecipient> = {}): CampaignRecipient {
  return {
    threadId: name.toLowerCase().replace(/\s+/g, ''),
    participantName: name,
    status: 'sent',
    renderedMessage: `Hi ${name.split(' ')[0]}, want to hear about the offer?`,
    attempts: 1,
    ...over,
  };
}

function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: 'camp_1',
    name: 'September offer',
    template: 'Hi {{firstName}}, want to hear about the offer?',
    dryRun: false,
    createdAt: 1_000,
    status: 'completed',
    recipients: [recipient('Dana Ellis'), recipient('Flavia Passos')],
    cursor: 2,
    config: { minDelayMs: 0, maxDelayMs: 0, batchSize: 5, batchJitter: 0, pauseMinMs: 0, pauseMaxMs: 0 },
    batches: [],
    sentSinceBatchPause: 0,
    currentBatchTarget: 5,
    ...over,
  };
}

describe('campaignMatchesQuery', () => {
  it('matches everything on an empty query', () => {
    expect(campaignMatchesQuery(campaign(), '   ')).toBe(true);
  });

  it('matches the campaign name', () => {
    expect(campaignMatchesQuery(campaign(), 'september')).toBe(true);
  });

  it('matches the template text', () => {
    expect(campaignMatchesQuery(campaign(), 'hear about')).toBe(true);
  });

  it('matches a recipient name', () => {
    expect(campaignMatchesQuery(campaign(), 'flavia')).toBe(true);
  });

  it('matches the exact message a recipient was sent', () => {
    const c = campaign({
      recipients: [recipient('Dana Ellis', { renderedMessage: 'Hi Dana, the webinar is Thursday.' })],
    });
    expect(campaignMatchesQuery(c, 'webinar')).toBe(true);
  });

  it('matches the error a send failed with', () => {
    const c = campaign({
      recipients: [recipient('Dana Ellis', { status: 'error', error: "Couldn't send — thread unavailable" })],
    });
    expect(campaignMatchesQuery(c, 'unavailable')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(campaignMatchesQuery(campaign(), 'kangaroo')).toBe(false);
  });

  it('requires every term', () => {
    expect(campaignMatchesQuery(campaign(), 'september dana')).toBe(true);
    expect(campaignMatchesQuery(campaign(), 'september kangaroo')).toBe(false);
  });

  // Terms not satisfied by the campaign's own text must all land on the SAME
  // person, or "dana thursday" would match a campaign where Dana exists and,
  // separately, somebody else was told about Thursday.
  it('requires unmatched terms to land on one recipient', () => {
    const c = campaign({
      recipients: [
        recipient('Dana Ellis', { renderedMessage: 'Hi Dana, the webinar is Thursday.' }),
        recipient('Kai Burns', { renderedMessage: 'Hi Kai, the workshop is Monday.' }),
      ],
    });
    expect(campaignMatchesQuery(c, 'dana thursday')).toBe(true);
    expect(campaignMatchesQuery(c, 'dana monday')).toBe(false);
  });
});

describe('matchingRecipients', () => {
  it('returns everyone when the campaign itself matched', () => {
    expect(matchingRecipients(campaign(), 'september')).toHaveLength(2);
  });

  it('narrows to the rows that matched', () => {
    const rows = matchingRecipients(campaign(), 'flavia');
    expect(rows.map((r) => r.participantName)).toEqual(['Flavia Passos']);
  });

  it('returns everyone on an empty query', () => {
    expect(matchingRecipients(campaign(), '')).toHaveLength(2);
  });
});

describe('failedRecipients', () => {
  it('picks out the failed sends', () => {
    const c = campaign({
      recipients: [
        recipient('Dana Ellis'),
        recipient('Kai Burns', { status: 'error', error: 'no composer' }),
        recipient('Jay Vics', { status: 'error', errorKind: 'unread', error: 'Skipped — unread' }),
      ],
    });
    expect(failedRecipients(c).map((r) => r.participantName)).toEqual(['Kai Burns', 'Jay Vics']);
  });
});

describe('collectUnseenFailures with archiving', () => {
  const failing = campaign({
    recipients: [recipient('Kai Burns', { status: 'error', error: 'no composer', failedAt: 9_000 })],
  });

  it('reports a failure from a live campaign', () => {
    expect(collectUnseenFailures([failing], 0)).toHaveLength(1);
  });

  // Filing a campaign away has to silence its banner too, or archiving it
  // would leave the notice on screen with no way to make it stop.
  it('stays quiet about an archived campaign', () => {
    expect(collectUnseenFailures([{ ...failing, archived: true }], 0)).toHaveLength(0);
  });
});

describe('failureReport', () => {
  const failing = (name: string, first: string | null, error: string) => recipient(name, {
    status: 'error',
    error,
    errorKind: 'unconfirmed',
    log: [
      '[t] navigating to https://www.facebook.com/messages/t/1/',
      ...(first ? [`[t] first attempt did not confirm as sent: ${first}`] : []),
      '[t] recovery: opening profile https://facebook.com/x',
    ],
  });

  it('tallies final and first-attempt errors and includes every log line', () => {
    const c = campaign({
      recipients: [
        recipient('Dana Ellis', { sentAt: 5 }),
        failing('Flavia Passos', 'Could not confirm message was delivered', 'Drawer X'),
        failing('Gus Hale', 'Could not confirm message was delivered', 'Drawer X'),
        failing('Ivy Moss', null, 'Message composer not found'),
      ],
    });
    const text = failureReport(c, (id) => (id === 'gushale' ? 'https://facebook.com/gus' : undefined));
    expect(text).toContain('Totals: 1 sent · 3 failed');
    expect(text).toContain('2 × [unconfirmed] Drawer X');
    expect(text).toContain('2 × Could not confirm message was delivered');
    expect(text).toContain('1 × (no recovery — first attempt was final)');
    expect(text).toContain('profileUrl: https://facebook.com/gus');
    expect(text.match(/recovery: opening profile/g)).toHaveLength(3);
  });
});

describe('capLog', () => {
  it('keeps the head (first attempt) and the tail (outcome) of a long log', () => {
    const log = Array.from({ length: 250 }, (_, i) => `line ${i}`);
    const capped = capLog(log);
    expect(capped).toHaveLength(MAX_LOG_LINES);
    expect(capped[0]).toBe('line 0');
    expect(capped[capped.length - 1]).toBe('line 249');
    expect(capped.some((l) => l.includes('omitted'))).toBe(true);
  });

  it('leaves a short log alone', () => {
    expect(capLog(['a', 'b'])).toEqual(['a', 'b']);
  });
});
