import test from 'node:test';
import assert from 'node:assert/strict';
import { diffInventories } from '../src/diff.mjs';

function inventory(boot, rows) {
  return { status: 'complete', scan: { boot }, rows };
}

function row(ifName, counter, width) {
  const cell = value => (value === null ? { status: 'missing', verified: true } : { value });
  return {
    index: { suffix: '1.7', parts: [1, 7] },
    cells: { ifName: cell(ifName), counter: cell(counter), width: cell(width) },
    missing: [],
  };
}

test('计数器回绕按位宽修正差值', () => {
  const diff = diffInventories(
    inventory('boot-1', { '1.7': row('岸桥A', '4294967290', 32) }),
    inventory('boot-1', { '1.7': row('岸桥A', '4', 32) }),
  );
  assert.equal(diff.restarted, false);
  assert.equal(diff.stable['1.7'].counter.delta, '10');
  assert.equal(diff.stable['1.7'].counter.wrap, true);
  assert.equal(diff.stable['1.7'].counter.width, 32);
});

test('64 位计数器回绕按 64 位修正', () => {
  const diff = diffInventories(
    inventory('boot-1', { '1.7': row('岸桥A', '18446744073709551615', 64) }),
    inventory('boot-1', { '1.7': row('岸桥A', '0', 64) }),
  );
  assert.equal(diff.stable['1.7'].counter.delta, '1');
  assert.equal(diff.stable['1.7'].counter.wrap, true);
});

test('设备重启后计数器差值置空', () => {
  const diff = diffInventories(
    inventory('boot-1', { '1.7': row('岸桥A', '4294967290', 32) }),
    inventory('boot-2', { '1.7': row('岸桥A', '4', 32) }),
  );
  assert.equal(diff.restarted, true);
  assert.equal(diff.stable['1.7'].counter.delta, null);
  assert.match(diff.stable['1.7'].counter.reason, /启动标识/);
  assert.ok(diff.notes.some(note => /虚假流量/.test(note)));
});

test('计数器缺失或位宽缺失时不猜测差值', () => {
  const missing = diffInventories(
    inventory('boot-1', { '1.7': row('岸桥A', null, 64) }),
    inventory('boot-1', { '1.7': row('岸桥A', '9', 64) }),
  );
  assert.equal(missing.stable['1.7'].counter.delta, null);
  assert.match(missing.stable['1.7'].counter.reason, /缺失/);
  const noWidth = diffInventories(
    inventory('boot-1', { '1.7': row('岸桥A', '100', null) }),
    inventory('boot-1', { '1.7': row('岸桥A', '50', null) }),
  );
  assert.equal(noWidth.stable['1.7'].counter.delta, null);
  assert.match(noWidth.stable['1.7'].counter.reason, /位宽/);
});

test('新增与移除接口按后缀列出并解释', () => {
  const diff = diffInventories(
    inventory('boot-1', { '1.7': row('岸桥A', '1', 32), '1.8': row('岸桥B', '2', 64) }),
    inventory('boot-1', { '1.7': row('岸桥A', '5', 32), '2.1': row('交换机', '3', 32) }),
  );
  assert.deepEqual(diff.added, ['2.1']);
  assert.deepEqual(diff.removed, ['1.8']);
  assert.equal(diff.stable['1.7'].counter.delta, '4');
  assert.equal(diff.stable['1.7'].counter.wrap, false);
  assert.ok(diff.notes.some(note => /新增接口/.test(note)));
  assert.ok(diff.notes.some(note => /移除接口/.test(note)));
});

test('名称变化与缺失侧标注', () => {
  const diff = diffInventories(
    inventory('boot-1', { '1.7': row('岸桥A', '1', 32) }),
    inventory('boot-1', { '1.7': row('岸桥B', '1', 32) }),
  );
  assert.equal(diff.stable['1.7'].ifName.changed, true);
  const becameMissing = diffInventories(
    inventory('boot-1', { '1.7': row('岸桥A', '1', 32) }),
    inventory('boot-1', { '1.7': row(null, '1', 32) }),
  );
  assert.equal(becameMissing.stable['1.7'].ifName.missing, 'current');
});
