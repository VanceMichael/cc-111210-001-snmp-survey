import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture } from '../fixtures/source.mjs';
import { startService } from './service.mjs';
import { collectTable } from './walk.mjs';
import { readJsonFile, writeJsonFile } from './store.mjs';

const directory = await mkdtemp(join(tmpdir(), 'capture-demo-'));
const source = await startFixture();
let service;
const show = (step, data) => console.log(JSON.stringify({ step, ...data }, null, 2));
try {
  service = await startService({ source: source.url, directory });

  // 保留用途：单次查看网关响应
  const receipt = await (await fetch(service.url + '/receive?key=demo')).json();
  show('单次查看（保留用途）', { receipt });

  // 第一轮整表采集：稀疏表，1.8 缺计数器
  const first = await (await fetch(service.url + '/collect')).json();
  show('第一轮整表采集（稀疏表）', { status: first.inventory.status, scan: first.inventory.scan, rows: first.inventory.rows });

  // 第二轮：新增接口 + 计数器按位宽回绕
  await fetch(source.url + '/topology');
  await fetch(source.url + '/tick?amount=10');
  const second = await (await fetch(service.url + '/collect')).json();
  show('第二轮：新增接口且计数器回绕', { changes: second.changes });

  // 第三轮：设备重启，计数器差值必须置空
  await fetch(source.url + '/restart');
  const third = await (await fetch(service.url + '/collect')).json();
  show('第三轮：设备重启后不产生虚假差值', { changes: third.changes });

  // 扫描期间拓扑变化：有边界重读后完成
  await fetch(source.url + '/topology?full=1&suffix=4.1&afterCalls=4');
  const fourth = await (await fetch(service.url + '/collect')).json();
  show('扫描期间拓扑变化（有边界重读）', { status: fourth.inventory.status, scan: fourth.inventory.scan });

  // 列间断点续采：进程在列与列之间停止后接着采
  const statePath = join(directory, 'resume-state.json');
  const loadState = () => readJsonFile(statePath);
  const saveState = async state => (state === null ? rm(statePath, { force: true }) : writeJsonFile(statePath, state));
  const paused = await collectTable(source.url, { maxColumnsPerRun: 1, loadState, saveState });
  const resumed = await collectTable(source.url, { loadState, saveState });
  show('列间暂停后续采', { paused: paused.status, remaining: paused.remainingColumns, resumed: resumed.status, rows: Object.keys(resumed.rows) });
} finally {
  await service?.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
