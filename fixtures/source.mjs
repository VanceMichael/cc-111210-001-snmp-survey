import { listen } from '../src/http.mjs';
import { oidCompare } from '../src/connector.mjs';
export async function startFixture() {
  let epoch = 1;
  let calls = 0;
  const columns = {
    '1.3.6.1.4.1.900.1': [['1.7', '岸桥A'], ['1.8', '岸桥B'], ['2.1', '交换机']],
    '1.3.6.1.4.1.900.2': [['1.7', '4294967290'], ['2.1', '120']],
    '1.3.6.1.4.1.900.3': [['1.7', 32], ['1.8', 64], ['2.1', 32]],
  };
  return listen(async url => {
    if (url.pathname === '/restart') { epoch++; return { body: { epoch } }; }
    if (url.pathname === '/topology') { columns['1.3.6.1.4.1.900.1'].push(['3.1', '新增接口']); return { body: { changed: true } }; }
    if (url.pathname !== '/bulk') return { status: 404, body: {} };
    calls++;
    const after = url.searchParams.get('after') ?? '';
    const limit = Math.min(3, Number(url.searchParams.get('limit') ?? 2));
    if (!Number.isInteger(limit) || limit < 1) throw new Error('响应大小无效');
    const cells = Object.entries(columns).flatMap(([root, rows]) => rows.map(([suffix, value]) => ({ oid: root + '.' + suffix, value })));
    cells.sort((left, right) => oidCompare(left.oid, right.oid));
    return { body: { boot: 'boot-' + epoch, calls, cells: cells.filter(cell => oidCompare(cell.oid, after) > 0).slice(0, limit), endOfMibView: !cells.some(cell => oidCompare(cell.oid, after) > 0) } };
  });
}
