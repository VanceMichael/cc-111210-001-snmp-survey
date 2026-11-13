import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReceiptStore, readJsonFile } from '../src/store.mjs';
import { startService } from '../src/service.mjs';
import { startFixture } from '../fixtures/source.mjs';

test('接收记录支持同内容重复领取并拒绝覆盖', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'receipt-'));
  try {
    const store = new ReceiptStore(directory);
    assert.deepEqual(await store.save('one', { value: 3 }), await store.save('one', { value: 3 }));
    await assert.rejects(store.save('one', { value: 4 }), /冲突/);
    await assert.rejects(store.save('../escape', {}), /无效/);
    const receipt = JSON.parse(await readFile(join(directory, 'one.json'), 'utf8'));
    receipt.value.value = 8;
    await writeFile(join(directory, 'one.json'), JSON.stringify(receipt));
    await assert.rejects(store.read('one'), /校验失败/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('服务健康检查和单次查看走真实来源', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'service-'));
  const fixture = await startFixture();
  const service = await startService({ source: fixture.url, directory });
  try {
    assert.equal((await (await fetch(service.url + '/health')).json()).state, 'ready');
    const response = await fetch(service.url + '/inspect');
    assert.equal(response.status, 200, await response.text());
    assert.equal((await fetch(service.url + '/missing')).status, 404);
  } finally { await service.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

test('整表采集接口输出清单并解释两轮变化', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'service-'));
  const fixture = await startFixture();
  const service = await startService({ source: fixture.url, directory });
  try {
    const first = await (await fetch(service.url + '/collect')).json();
    assert.equal(first.inventory.status, 'complete');
    assert.equal(first.changes, null);
    assert.equal(first.inventory.rows['1.8'].cells.counter.status, 'missing');
    await fetch(fixture.url + '/topology');
    await fetch(fixture.url + '/tick?amount=10');
    const second = await (await fetch(service.url + '/collect')).json();
    assert.equal(second.inventory.status, 'complete');
    assert.deepEqual(second.changes.added, ['3.1']);
    assert.equal(second.changes.restarted, false);
    assert.equal(second.changes.stable['1.7'].counter.delta, '10');
    assert.equal(second.changes.stable['1.7'].counter.wrap, true);
    assert.equal(await readJsonFile(join(directory, 'scan-state.json')), null);
    assert.ok(await readJsonFile(join(directory, 'inventory.json')));
    await fetch(fixture.url + '/flap?every=2');
    const unstable = await (await fetch(service.url + '/collect')).json();
    assert.equal(unstable.status, 'incomplete');
    assert.equal(unstable.reason, 'boot-changed');
    const kept = await readJsonFile(join(directory, 'inventory.json'));
    assert.equal(kept.scan.id, second.inventory.scan.id);
  } finally { await service.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});
