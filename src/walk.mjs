import { randomUUID } from 'node:crypto';
import { get } from './http.mjs';
import { oidCompare } from './connector.mjs';

export const COLUMNS = [
  { root: '1.3.6.1.4.1.900.1', name: 'ifName', kind: 'label' },
  { root: '1.3.6.1.4.1.900.2', name: 'counter', kind: 'counter' },
  { root: '1.3.6.1.4.1.900.3', name: 'width', kind: 'width' },
];

class ScanAbort extends Error {
  constructor(reason, message, retryable = true) {
    super(message);
    this.reason = reason;
    this.retryable = retryable;
  }
}

class StaleState extends Error {}

function isUnder(root, oid) {
  return typeof oid === 'string' && oid.startsWith(root + '.');
}

function suffixSet(columnResult) {
  return new Set(columnResult.cells.map(cell => cell.suffix));
}

function sameSet(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

// 采集整张管理表：每个列根独立按词典序推进，行身份取完整 OID 后缀，
// 不按返回位置拼接。重读与重试均有边界，超限返回 incomplete 与明确原因。
export async function collectTable(base, options = {}) {
  const columns = options.columns ?? COLUMNS;
  const limit = options.limit ?? 2;
  const maxAttempts = options.maxAttempts ?? 3;
  const maxRequests = options.maxRequests ?? 200;
  const maxColumnsPerRun = options.maxColumnsPerRun ?? Number.POSITIVE_INFINITY;
  const loadState = options.loadState ?? (async () => null);
  const saveState = options.saveState ?? (async () => {});
  const startedAt = new Date().toISOString();
  const retries = [];
  let requests = 0;
  let boot = null;
  let confirmedThisCall = false;
  let done = new Map();
  let scanId = randomUUID();

  const saved = await loadState();
  if (saved && saved.boot && saved.columns) {
    scanId = saved.scanId ?? scanId;
    boot = saved.boot;
    done = new Map(Object.entries(saved.columns));
  }

  const checkpoint = async () => {
    await saveState(done.size ? { scanId, boot, columns: Object.fromEntries(done) } : null);
  };

  const request = async cursor => {
    requests++;
    if (requests > maxRequests) throw new ScanAbort('request-limit-exceeded', `请求数超过上限 ${maxRequests}`, false);
    let response;
    try {
      response = await (await get(base, '/bulk?after=' + encodeURIComponent(cursor) + '&limit=' + limit)).json();
    } catch (error) {
      throw new ScanAbort('source-error', `来源请求失败：${error.message}`, false);
    }
    if (boot === null) boot = response.boot;
    else if (response.boot !== boot) {
      if (!confirmedThisCall) {
        // 暂停期间设备重启：丢弃旧进度，不混用另一次启动的数据
        done = new Map();
        boot = null;
        await saveState(null);
        throw new StaleState('暂停期间设备重启，已丢弃旧进度');
      }
      throw new ScanAbort('boot-changed', '扫描期间设备启动标识变化');
    }
    confirmedThisCall = true;
    return response;
  };

  const walkColumn = async column => {
    const cells = [];
    let cursor = column.root;
    while (true) {
      const response = await request(cursor);
      let advanced = false;
      let leftRoot = false;
      for (const cell of Array.isArray(response.cells) ? response.cells : []) {
        if (!isUnder(column.root, cell.oid)) { leftRoot = true; break; }
        if (oidCompare(cell.oid, cursor) <= 0) throw new ScanAbort('source-error', '来源返回的 OID 未推进', false);
        cells.push({
          suffix: cell.oid.slice(column.root.length + 1),
          oid: cell.oid,
          value: cell.value,
          source: { request: requests, gatewayCalls: response.calls ?? null, boot: response.boot },
        });
        cursor = cell.oid;
        advanced = true;
      }
      if (leftRoot) return { cells, ended: 'adjacent-subtree' };
      if (response.endOfMibView) return { cells, ended: 'end-of-mib-view' };
      if (!advanced) throw new ScanAbort('source-error', '来源响应无法推进扫描', false);
    }
  };

  while (true) {
    try {
      let walkedThisCall = 0;
      for (const column of columns) {
        if (done.has(column.root)) continue;
        if (walkedThisCall >= maxColumnsPerRun) {
          await checkpoint();
          return {
            status: 'paused',
            scanId,
            boot,
            requests,
            completedColumns: columns.filter(c => done.has(c.root)).map(c => c.name),
            remainingColumns: columns.filter(c => !done.has(c.root)).map(c => c.name),
            message: '已在列边界暂停，可再次调用续采',
          };
        }
        done.set(column.root, await walkColumn(column));
        walkedThisCall++;
        await checkpoint();
      }
      // 行集合复核：任何列与并集不一致时，全部列重读一次，
      // 以区分稳定缺失与扫描期间的拓扑变化
      const union = new Set();
      for (const result of done.values()) for (const cell of result.cells) union.add(cell.suffix);
      const verification = [];
      const sparse = columns.some(column => !sameSet(suffixSet(done.get(column.root)), union));
      if (sparse) {
        for (const column of columns) {
          const before = suffixSet(done.get(column.root));
          const again = suffixSet(await walkColumn(column));
          const stable = sameSet(before, again);
          verification.push({ column: column.name, rows: before.size, stable });
          if (!stable) throw new ScanAbort('topology-changed', `列 ${column.name} 的行集合在扫描期间变化`);
        }
      }
      await saveState(null);
      const bySuffix = new Map(columns.map(column => {
        const map = new Map();
        for (const cell of done.get(column.root).cells) map.set(cell.suffix, cell);
        return [column.name, map];
      }));
      const rows = {};
      for (const suffix of [...union].sort(oidCompare)) {
        const cells = {};
        const missing = [];
        for (const column of columns) {
          const found = bySuffix.get(column.name).get(suffix);
          if (found) cells[column.name] = { oid: found.oid, value: found.value, source: found.source };
          else { cells[column.name] = { status: 'missing', verified: true }; missing.push(column.name); }
        }
        rows[suffix] = { index: { suffix, parts: suffix.split('.').map(Number) }, cells, missing };
      }
      return {
        status: 'complete',
        scan: {
          id: scanId,
          boot,
          attempts: retries.length + 1,
          retries: [...retries],
          requests,
          startedAt,
          finishedAt: new Date().toISOString(),
          columns: columns.map(column => ({ name: column.name, root: column.root, rows: done.get(column.root).cells.length, ended: done.get(column.root).ended })),
          verification,
          consistency: verification.length
            ? '扫描期间设备启动标识不变；存在稀疏列，已全量重读确认行集合稳定，缺失单元格为稳定缺失'
            : '扫描期间设备启动标识不变；各列行集合一致，无需重读',
        },
        rows,
      };
    } catch (error) {
      if (error instanceof StaleState) continue;
      if (!(error instanceof ScanAbort)) throw error;
      retries.push({ reason: error.reason, message: error.message });
      done = new Map();
      boot = null;
      confirmedThisCall = false;
      await saveState(null);
      if (!error.retryable || retries.length >= maxAttempts) {
        return { status: 'incomplete', reason: error.reason, message: error.message, attempts: retries, requests };
      }
    }
  }
}
