// Drag-and-drop in the advanced search builder: search.moveNode.

import { describe, it, expect } from 'vitest';
import { moveNode, type QueryGroup, type QueryNode } from './search';

const c = (id: string): QueryNode => ({ type: 'condition', id, field: 'name', op: 'contains', value: id });
const g = (id: string, children: QueryNode[]): QueryGroup => ({ type: 'group', id, combinator: 'and', children });

/** Ids in tree order, groups shown as id[...]. */
function shape(n: QueryNode): string {
  return n.type === 'condition' ? n.id : `${n.id}[${n.children.map(shape).join(',')}]`;
}

const tree = () => g('root', [c('a'), c('b'), g('inner', [c('x'), c('y')]), c('d')]);

describe('moveNode', () => {
  it('moves a condition down within its group, landing where it was dropped', () => {
    // Dropped on the line before 'd' (index 3 in the original order).
    expect(shape(moveNode(tree(), 'a', 'root', 3))).toBe('root[b,inner[x,y],a,d]');
  });

  it('moves a condition up within its group', () => {
    expect(shape(moveNode(tree(), 'd', 'root', 0))).toBe('root[d,a,b,inner[x,y]]');
  });

  it('moves a condition into a nested group and back out', () => {
    const into = moveNode(tree(), 'b', 'inner', 1);
    expect(shape(into)).toBe('root[a,inner[x,b,y],d]');
    expect(shape(moveNode(into, 'x', 'root', 0))).toBe('root[x,a,inner[b,y],d]');
  });

  it('moves a whole group', () => {
    expect(shape(moveNode(tree(), 'inner', 'root', 0))).toBe('root[inner[x,y],a,b,d]');
  });

  it('refuses to drop a group inside itself, and ignores a no-op drop', () => {
    const t = tree();
    expect(moveNode(t, 'inner', 'inner', 0)).toBe(t);
    expect(moveNode(t, 'b', 'root', 1)).toBe(t);
    expect(moveNode(t, 'b', 'root', 2)).toBe(t); // the line just below itself
    expect(moveNode(t, 'root', 'inner', 0)).toBe(t);
    expect(moveNode(t, 'nope', 'root', 0)).toBe(t);
  });

  it('appends to an empty group', () => {
    const t = g('root', [c('a'), g('empty', [])]);
    expect(shape(moveNode(t, 'a', 'empty', 0))).toBe('root[empty[a]]');
  });
});
