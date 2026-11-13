import { listen } from '../src/http.mjs';
import { oidCompare } from '../src/connector.mjs';

export async function startFixture() {
  let epoch = 1;
  let calls = 0;
  let flapEvery = 0;
  const pending = [];
  const columns = {
    '1.3.6.1.4.1.900.1': [['1.7', '岸桥A'], ['1.8', '岸桥B'], ['2.1', '交换机']],
    '1.3.6.1.4.1.900.2': [['1.7', '4294967290'], ['2.1', '120']],
    '1.3.6.1.4.1.900.3': [['1.7', 32], ['1.8', 64], ['2.1', 32]],
  };
  const widthOf = suffix => {
    const found = columns['1.3.6.1.4.1.900.3'].find(([item]) => item === suffix);
    return found ? Number(found[1]) : 64;
  };
  const hasCell = (root, suffix) => columns[root].some(([item]) => item === suffix);
  const addInterface = (suffix, full) => {
    if (!hasCell('1.3.6.1.4.1.900.1', suffix)) columns['1.3.6.1.4.1.900.1'].push([suffix, '新增接口']);
    if (full) {
      if (!hasCell('1.3.6.1.4.1.900.2', suffix)) columns['1.3.6.1.4.1.900.2'].push([suffix, '0']);
      if (!hasCell('1.3.6.1.4.1.900.3', suffix)) columns['1.3.6.1.4.1.900.3'].push([suffix, 32]);
    }
  };
  const removeInterface = suffix => {
    for (const root of Object.keys(columns)) columns[root] = columns[root].filter(([item]) => item !== suffix);
  };
  const schedule = (afterCalls, apply) => {
    if (afterCalls > 0) pending.push({ remaining: afterCalls, apply });
    else apply();
  };
  return listen(async url => {
    if (url.pathname === '/restart') {
      const afterCalls = Number(url.searchParams.get('afterCalls') ?? 0);
      schedule(afterCalls, () => { epoch++; });
      return { body: { epoch, scheduled: afterCalls > 0 } };
    }
    if (url.pathname === '/flap') {
      flapEvery = Number(url.searchParams.get('every') ?? 0);
      return { body: { flapEvery } };
    }
    if (url.pathname === '/topology') {
      const afterCalls = Number(url.searchParams.get('afterCalls') ?? 0);
      const suffix = url.searchParams.get('suffix') ?? '3.1';
      const full = url.searchParams.get('full') === '1';
      const remove = url.searchParams.get('mode') === 'remove';
      schedule(afterCalls, () => (remove ? removeInterface(suffix) : addInterface(suffix, full)));
      return { body: { changed: true, scheduled: afterCalls > 0 } };
    }
    if (url.pathname === '/tick') {
      const amount = BigInt(url.searchParams.get('amount') ?? '1');
      columns['1.3.6.1.4.1.900.2'] = columns['1.3.6.1.4.1.900.2'].map(([suffix, value]) => {
        const modulus = 1n << BigInt(widthOf(suffix));
        return [suffix, ((BigInt(value) + amount) % modulus).toString()];
      });
      return { body: { ticked: true } };
    }
    if (url.pathname !== '/bulk') return { status: 404, body: {} };
    calls++;
    for (let index = pending.length - 1; index >= 0; index--) {
      if (--pending[index].remaining <= 0) {
        pending[index].apply();
        pending.splice(index, 1);
      }
    }
    if (flapEvery > 0 && calls % flapEvery === 0) epoch++;
    const after = url.searchParams.get('after') ?? '';
    const limit = Math.min(3, Number(url.searchParams.get('limit') ?? 2));
    if (!Number.isInteger(limit) || limit < 1) throw new Error('响应大小无效');
    const cells = Object.entries(columns).flatMap(([root, rows]) => rows.map(([suffix, value]) => ({ oid: root + '.' + suffix, value })));
    cells.sort((left, right) => oidCompare(left.oid, right.oid));
    return { body: { boot: 'boot-' + epoch, calls, cells: cells.filter(cell => oidCompare(cell.oid, after) > 0).slice(0, limit), endOfMibView: !cells.some(cell => oidCompare(cell.oid, after) > 0) } };
  });
}
