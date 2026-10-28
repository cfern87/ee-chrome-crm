// Changing a condition's field keeps the operator and values when the new
// field holds the same type of data, and starts over when it doesn't.

import { describe, it, expect } from 'vitest';
import { buildFields, switchConditionField, type Condition } from './search';

const fields = buildFields({
  f1: { id: 'f1', name: 'Plan', type: 'select', options: ['basic', 'pro'], order: 0, createdAt: 1 },
  f2: { id: 'f2', name: 'Tier', type: 'select', options: ['pro', 'gold'], order: 1, createdAt: 2 },
} as any);

const cond = (over: Partial<Condition>): Condition => ({ type: 'condition', id: 'c1', field: 'name', op: 'contains', ...over });

describe('switchConditionField', () => {
  it('keeps a date test when moving between date fields', () => {
    const c = cond({ field: 'lastContactedAt', op: 'notInLast', value: '14', unit: 'weeks' });
    expect(switchConditionField(c, fields, 'updatedAt')).toEqual({ ...c, field: 'updatedAt' });
  });

  it('keeps a text test when moving between text fields', () => {
    const c = cond({ field: 'name', op: 'startsWith', value: 'Dr' });
    expect(switchConditionField(c, fields, 'email')).toEqual({ ...c, field: 'email' });
  });

  it('keeps the date test into a per-tag date, and drops the tag picker leaving it', () => {
    const c = cond({ field: 'lastContactedAt', op: 'before', value: '2026-01-01' });
    const toTag = switchConditionField(c, fields, 'tagDate');
    expect(toTag).toMatchObject({ field: 'tagDate', op: 'before', value: '2026-01-01' });
    const back = switchConditionField({ ...toTag, tagIds: ['t1'] }, fields, 'createdAt');
    expect(back.tagIds).toBeUndefined();
    expect(back).toMatchObject({ op: 'before', value: '2026-01-01' });
  });

  it('starts over when the data type changes', () => {
    const c = cond({ field: 'lastContactedAt', op: 'notInLast', value: '14', unit: 'weeks' });
    const next = switchConditionField(c, fields, 'name');
    expect(next).toEqual({ type: 'condition', id: 'c1', field: 'name', op: 'contains' });
  });

  it('keeps only the dropdown choices the new field offers', () => {
    const c = cond({ field: 'custom:f1', op: 'isAnyOf', values: ['basic', 'pro'] });
    expect(switchConditionField(c, fields, 'custom:f2')).toMatchObject({ op: 'isAnyOf', values: ['pro'] });
  });
});
