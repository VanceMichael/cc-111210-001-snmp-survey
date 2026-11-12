import test from 'node:test'; import assert from 'node:assert/strict';
import { inspect, oidCompare } from '../src/connector.mjs'; import { startFixture } from '../fixtures/source.mjs';
test('OID使用数值词典序而非字符串排序', () => { assert.ok(oidCompare('1.9', '1.10') < 0); assert.ok(oidCompare('1.9', '1.9.1') < 0); });
test('稀疏列与设备重启可观测', async () => { const source = await startFixture(); try { const first = await inspect(source.url); assert.equal(first.cells[0].value, '岸桥A'); await fetch(source.url + '/restart'); assert.notEqual((await inspect(source.url)).boot, first.boot); const sparse = await inspect(source.url, { after: '1.3.6.1.4.1.900.2' }); assert.equal(sparse.cells[1].oid, '1.3.6.1.4.1.900.2.2.1'); } finally { await source.close(); } });
