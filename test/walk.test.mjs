import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectTable } from '../src/walk.mjs';
import { listen } from '../src/http.mjs';
import { readJsonFile, writeJsonFile } from '../src/store.mjs';
import { startFixture } from '../fixtures/source.mjs';

test('整表采集按完整 OID 后缀对齐行并标注缺失', async () => {
  const source = await startFixture();
  try {
    const result = await collectTable(source.url);
    assert.equal(result.status, 'complete');
    assert.deepEqual(Object.keys(result.rows), ['1.7', '1.8', '2.1']);
    assert.deepEqual(result.rows['1.7'].index.parts, [1, 7]);
    assert.equal(result.rows['1.7'].cells.ifName.value, '岸桥A');
    assert.equal(result.rows['1.8'].cells.counter.status, 'missing');
    assert.equal(result.rows['1.8'].cells.counter.verified, true);
    assert.deepEqual(result.rows['1.8'].missing, ['counter']);
    const provenance = result.rows['1.7'].cells.counter.source;
    assert.equal(provenance.boot, result.scan.boot);
    assert.ok(provenance.request >= 1);
    assert.ok(provenance.gatewayCalls >= 1);
    assert.equal(result.scan.columns[0].ended, 'adjacent-subtree');
    assert.equal(result.scan.columns[2].ended, 'end-of-mib-view');
    assert.equal(result.scan.verification.length, 3);
    assert.ok(result.scan.verification.every(item => item.stable));
    for (const row of Object.values(result.rows)) {
      for (const cell of Object.values(row.cells)) {
        if (cell.source) assert.equal(cell.source.boot, result.scan.boot);
      }
    }
  } finally {
    await source.close();
  }
});

test('扫描期间新增接口触发有边界重读', async () => {
  const source = await startFixture();
  try {
    await fetch(source.url + '/topology?full=1&suffix=4.1&afterCalls=4');
    const result = await collectTable(source.url);
    assert.equal(result.status, 'complete');
    assert.equal(result.scan.attempts, 2);
    assert.equal(result.scan.retries[0].reason, 'topology-changed');
    assert.equal(result.rows['4.1'].cells.ifName.value, '新增接口');
    assert.equal(result.rows['4.1'].cells.counter.value, '0');
    assert.equal(result.rows['4.1'].missing.length, 0);
  } finally {
    await source.close();
  }
});

test('扫描期间移除接口触发有边界重读', async () => {
  const source = await startFixture();
  try {
    await fetch(source.url + '/topology?mode=remove&suffix=1.8&afterCalls=4');
    const result = await collectTable(source.url);
    assert.equal(result.status, 'complete');
    assert.equal(result.scan.attempts, 2);
    assert.equal(result.scan.retries[0].reason, 'topology-changed');
    assert.deepEqual(Object.keys(result.rows), ['1.7', '2.1']);
  } finally {
    await source.close();
  }
});

test('扫描期间设备重启后重采且不混用启动数据', async () => {
  const source = await startFixture();
  try {
    await fetch(source.url + '/restart?afterCalls=2');
    const result = await collectTable(source.url);
    assert.equal(result.status, 'complete');
    assert.equal(result.scan.attempts, 2);
    assert.equal(result.scan.retries[0].reason, 'boot-changed');
    assert.equal(result.scan.boot, 'boot-2');
    for (const row of Object.values(result.rows)) {
      for (const cell of Object.values(row.cells)) {
        if (cell.source) assert.equal(cell.source.boot, 'boot-2');
      }
    }
  } finally {
    await source.close();
  }
});

test('持续不稳定时返回明确不完整原因而非无限重试', async () => {
  const source = await startFixture();
  try {
    await fetch(source.url + '/flap?every=2');
    const result = await collectTable(source.url);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.reason, 'boot-changed');
    assert.equal(result.attempts.length, 3);
  } finally {
    await source.close();
  }
});

test('列间暂停后可续采，暂停期间重启不混用旧数据', async () => {
  const source = await startFixture();
  const directory = await mkdtemp(join(tmpdir(), 'walk-state-'));
  const statePath = join(directory, 'state.json');
  const loadState = () => readJsonFile(statePath);
  const saveState = async state => (state === null ? rm(statePath, { force: true }) : writeJsonFile(statePath, state));
  try {
    const paused = await collectTable(source.url, { maxColumnsPerRun: 1, loadState, saveState });
    assert.equal(paused.status, 'paused');
    assert.deepEqual(paused.remainingColumns, ['counter', 'width']);
    assert.ok(await readJsonFile(statePath));
    const resumed = await collectTable(source.url, { loadState, saveState });
    assert.equal(resumed.status, 'complete');
    assert.deepEqual(Object.keys(resumed.rows), ['1.7', '1.8', '2.1']);
    assert.equal(await readJsonFile(statePath), null);

    const pausedAgain = await collectTable(source.url, { maxColumnsPerRun: 1, loadState, saveState });
    assert.equal(pausedAgain.status, 'paused');
    await fetch(source.url + '/restart');
    const afterRestart = await collectTable(source.url, { loadState, saveState });
    assert.equal(afterRestart.status, 'complete');
    assert.equal(afterRestart.scan.boot, 'boot-2');
    for (const row of Object.values(afterRestart.rows)) {
      for (const cell of Object.values(row.cells)) {
        if (cell.source) assert.equal(cell.source.boot, 'boot-2');
      }
    }
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('请求数有边界，超过上限返回不完整', async () => {
  const source = await startFixture();
  try {
    const result = await collectTable(source.url, { maxRequests: 2 });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.reason, 'request-limit-exceeded');
    assert.equal(result.attempts.length, 1);
  } finally {
    await source.close();
  }
});

test('来源返回不推进的 OID 时明确报错', async () => {
  const stuck = await listen(async () => ({
    body: { boot: 'boot-1', calls: 1, cells: [{ oid: '1.3.6.1.4.1.900.1.1.7', value: 'x' }], endOfMibView: false },
  }));
  try {
    const result = await collectTable(stuck.url);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.reason, 'source-error');
  } finally {
    await stuck.close();
  }
});
