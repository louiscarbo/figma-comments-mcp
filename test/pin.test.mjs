import test from 'node:test';
import assert from 'node:assert/strict';
import { describePin, pinBox, pinTrail } from '../dist/figma.js';

const box = (x, y, width, height) => ({ x, y, width, height });
const node = (id, name, type, absoluteBoundingBox, extra = {}) => ({ id, name, type, absoluteBoundingBox, ...extra });
const text = (id, name, characters, bounds, extra = {}) => node(id, name, 'TEXT', bounds, { characters, ...extra });

// Origin deliberately far from 0,0 and negative on y: offsets must add to it.
const ROOT_X = 1000;
const ROOT_Y = -500;
const offset = (absoluteX, absoluteY) => ({ x: absoluteX - ROOT_X, y: absoluteY - ROOT_Y });
const pin = (absoluteX, absoluteY) => ({ node_id: '506:5214', node_offset: offset(absoluteX, absoluteY) });

const tree = node('506:5214', 'Round 5 · Torn Stub', 'FRAME', box(ROOT_X, ROOT_Y, 3038, 7128), {
  clipsContent: false,
  children: [
    node('507:1', 'Session card', 'FRAME', box(2500, 5700, 400, 300), {
      clipsContent: true,
      children: [
        node('507:2', 'Frame 12', 'FRAME', box(2520, 5800, 360, 100), {
          clipsContent: false,
          children: [
            text('508:7010', 'Start', 'Start', box(2530, 5840, 60, 24)),
            text('508:7009', 'End', 'End', box(2600, 5840, 60, 24))
          ]
        }),
        text('507:3', 'Hidden note', 'nope', box(2500, 5700, 400, 300), { visible: false })
      ]
    }),
    node('507:4', 'Hidden section', 'FRAME', box(1100, 100, 500, 500), {
      visible: false,
      children: [text('507:5', 'Inside hidden', 'nope', box(1150, 150, 100, 100))]
    })
  ]
});

const ids = (trail) => trail.map((layer) => layer.id);

test('nested frames: resolves the deepest layer, and prints the requested format', () => {
  const pinned = pin(2626, 5852);
  assert.deepEqual(ids(pinTrail(tree, pinned)), ['506:5214', '507:1', '507:2', '508:7009']);
  assert.equal(describePin(tree, pinned), '→ 508:7009 "End" TEXT "End" in "Session card" at 1626,6352');
});

test('invisible layer on top is skipped', () => {
  const trail = pinTrail(tree, pin(2626, 5852));
  assert.ok(!ids(trail).includes('507:3'));
});

test('a hidden layer hides its whole subtree', () => {
  assert.deepEqual(ids(pinTrail(tree, pin(1200, 200))), ['506:5214']);
});

test('point outside every child resolves to the frame itself', () => {
  const pinned = pin(1005, -495);
  assert.deepEqual(ids(pinTrail(tree, pinned)), ['506:5214']);
  assert.equal(describePin(tree, pinned), 'at 5,5');
});

test('region spanning two siblings resolves to their parent', () => {
  const pinned = {
    node_id: '506:5214',
    node_offset: offset(2535, 5845),
    region_width: 115,
    region_height: 15,
    comment_pin_corner: 'top-left'
  };
  assert.deepEqual(ids(pinTrail(tree, pinned)), ['506:5214', '507:1', '507:2']);
  assert.equal(describePin(tree, pinned), '→ 507:2 "Frame 12" FRAME in "Session card" at 1535,6345 115×15');
});

test('region inside one sibling resolves to that sibling', () => {
  const pinned = {
    node_id: '506:5214',
    node_offset: offset(2605, 5845),
    region_width: 40,
    region_height: 10,
    comment_pin_corner: 'top-left'
  };
  assert.equal(pinTrail(tree, pinned).at(-1).id, '508:7009');
});

test('region anchor follows comment_pin_corner, and defaults to bottom-right', () => {
  const size = { region_width: 115, region_height: 15 };
  const expected = { x: 1535, y: 6345, width: 115, height: 15 };
  const anchors = [
    ['top-left', 2535, 5845],
    ['top-right', 2650, 5845],
    ['bottom-left', 2535, 5860],
    ['bottom-right', 2650, 5860],
    [undefined, 2650, 5860]
  ];
  for (const [corner, x, y] of anchors) {
    const pinned = { node_id: '506:5214', node_offset: offset(x, y), ...size };
    if (corner) pinned.comment_pin_corner = corner;
    assert.deepEqual(pinBox(pinned), expected, `corner ${corner}`);
    assert.equal(pinTrail(tree, pinned).at(-1).id, '507:2', `corner ${corner}`);
  }
});

test('a plain pin ignores the corner and is a zero-size box', () => {
  assert.deepEqual(pinBox({ node_id: '1:1', node_offset: { x: 7, y: 9 } }), { x: 7, y: 9, width: 0, height: 0 });
});

test('overlapping siblings: the last child is on top', () => {
  const stack = node('1:0', 'Stack', 'FRAME', box(0, 0, 100, 100), {
    children: [
      node('1:1', 'Back', 'RECTANGLE', box(0, 0, 100, 100)),
      node('1:2', 'Front', 'RECTANGLE', box(0, 0, 100, 100))
    ]
  });
  const pinned = { node_id: '1:0', node_offset: { x: 50, y: 50 } };
  assert.equal(pinTrail(stack, pinned).at(-1).id, '1:2');
  assert.equal(pinTrail({ ...stack, itemReverseZIndex: true }, pinned).at(-1).id, '1:1');
});

test('overflow: unclipped children are hit, clipped ones are not', () => {
  const build = (clipsContent) =>
    node('2:0', 'Board', 'FRAME', box(0, 0, 500, 500), {
      children: [
        node('2:1', 'Card', 'FRAME', box(100, 100, 100, 100), {
          clipsContent,
          children: [node('2:2', 'Badge', 'RECTANGLE', box(190, 190, 40, 40))]
        })
      ]
    });
  const pinned = { node_id: '2:0', node_offset: { x: 220, y: 220 } };
  assert.deepEqual(ids(pinTrail(build(false), pinned)), ['2:0', '2:1', '2:2']);
  assert.deepEqual(ids(pinTrail(build(true), pinned)), ['2:0']);
});

test('a pin outside the frame resolves to the frame', () => {
  assert.deepEqual(ids(pinTrail(tree, { node_id: '506:5214', node_offset: { x: -40, y: 9000 } })), ['506:5214']);
});

test('a hidden pinned node stays the answer instead of leaking its children', () => {
  const hidden = node('3:0', 'Off', 'FRAME', box(0, 0, 100, 100), {
    visible: false,
    children: [node('3:1', 'Child', 'RECTANGLE', box(0, 0, 100, 100))]
  });
  assert.deepEqual(ids(pinTrail(hidden, { node_id: '3:0', node_offset: { x: 5, y: 5 } })), ['3:0']);
});

test('a child with null bounds does not throw', () => {
  const sparse = node('4:0', 'Root', 'FRAME', box(0, 0, 100, 100), {
    children: [node('4:1', 'Vector', 'VECTOR', null), node('4:2', 'Target', 'RECTANGLE', box(0, 0, 50, 50))]
  });
  assert.equal(pinTrail(sparse, { node_id: '4:0', node_offset: { x: 5, y: 5 } }).at(-1).id, '4:2');
});

test('no bounds on the pinned node, or no offset: empty, so the line stays as it was', () => {
  const page = { id: '0:1', name: 'Page 1', type: 'CANVAS', children: [] };
  assert.equal(pinTrail(page, { node_id: '0:1', node_offset: { x: 1, y: 1 } }), null);
  assert.equal(describePin(page, { node_id: '0:1', node_offset: { x: 1, y: 1 } }), '');
  assert.equal(describePin(tree, { x: 1, y: 2 }), '');
  assert.equal(describePin(tree, null), '');
});

test('default container names are skipped; the pinned frame is not repeated', () => {
  const generic = node('5:0', 'Screen', 'FRAME', box(0, 0, 100, 100), {
    children: [
      node('5:1', 'Group 4', 'GROUP', box(0, 0, 100, 100), {
        children: [node('5:2', 'Rectangle 9', 'RECTANGLE', box(0, 0, 100, 100))]
      })
    ]
  });
  assert.equal(
    describePin(generic, { node_id: '5:0', node_offset: { x: 1, y: 1 } }),
    '→ 5:2 "Rectangle 9" RECTANGLE at 1,1'
  );
});

test('text previews are flattened and capped; a pin on a TEXT node shows its text', () => {
  const long = text('6:0', 'Body', `First line\n\nsecond ${'word '.repeat(40)}`, box(0, 0, 100, 100));
  const printed = describePin(long, { node_id: '6:0', node_offset: { x: 1.4, y: 1.6 } });
  assert.match(printed, /^"First line second word .*…" at 1,2$/);
  assert.ok(printed.length < 80);
});
