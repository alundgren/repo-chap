import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutCanvas } from '../apps/desktop/src/canvas-layout.ts';

test('canvas routes shared outcomes orthogonally without overlapping steps', async () => {
  const nodes = ['repair', 'review', 'checks', 'push', 'handoff', 'wait'].map(id => ({ id, width: 224, height: 146 }));
  const edges = [
    { from: 'repair', to: 'checks', label: 'Completed', failure: false },
    { from: 'review', to: 'checks', label: 'Completed', failure: false },
    { from: 'checks', to: 'push', label: 'Passed', failure: false },
    ...['repair', 'review', 'checks', 'push'].map(from => ({ from, to: 'handoff', label: 'Failed', failure: true })),
    { from: 'handoff', to: 'wait', label: 'Completed', failure: false },
  ];
  const before = JSON.stringify({ nodes, edges });
  const result = await layoutCanvas(nodes, edges);
  assert.equal(JSON.stringify({ nodes, edges }), before);
  assert.equal(result.nodes.size, nodes.length);
  assert.equal(result.edges.length, edges.length);
  for (const [id, node] of result.nodes) {
    for (const [otherId, other] of result.nodes) {
      if (id === otherId) continue;
      assert.ok(Math.abs(node.x - other.x) >= (node.width + other.width) / 2 || Math.abs(node.y - other.y) >= (node.height + other.height) / 2, `${id} overlaps ${otherId}`);
    }
  }
  result.edges.forEach((route, index) => {
    const source = result.nodes.get(edges[index]!.from)!;
    const target = result.nodes.get(edges[index]!.to)!;
    assert.ok(route.points.length >= 2);
    const first = route.points[0]!, last = route.points.at(-1)!;
    if (edges[index]!.failure) assert.equal(first.y, source.y + source.height / 2);
    else assert.equal(first.x, source.x + source.width / 2);
    assert.equal(last.x, target.x - target.width / 2);
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1]!, b = route.points[i]!;
      assert.ok(a.x === b.x || a.y === b.y, 'route must be orthogonal');
      for (const node of result.nodes.values()) {
        const left = node.x - node.width / 2, right = node.x + node.width / 2;
        const top = node.y - node.height / 2, bottom = node.y + node.height / 2;
        const intersects = a.x === b.x
          ? a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom
          : a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
        assert.equal(intersects, false, 'connection passes through a step');
      }
    }
  });
});

test('canvas retains both parallel outcomes and cyclic continuations', async () => {
  const nodes = ['review', 'wait'].map(id => ({ id, width: 224, height: 146 }));
  const edges = [
    { from: 'review', to: 'review', label: 'Completed', failure: false },
    { from: 'review', to: 'wait', label: 'Failed', failure: true },
    { from: 'wait', to: 'review', label: 'Completed', failure: false },
    { from: 'wait', to: 'review', label: 'Failed', failure: true },
  ];
  const result = await layoutCanvas(nodes, edges);
  assert.equal(result.edges.length, 4);
  assert.ok(result.edges.every(edge => edge.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))));
  assert.notDeepEqual(result.edges[2]!.points, result.edges[3]!.points);
});
