import { listen } from './http.mjs';
import { inspect } from './connector.mjs';
import { collectTable } from './walk.mjs';
import { diffInventories } from './diff.mjs';
import { InventoryStore, ReceiptStore } from './store.mjs';

export async function startService({ source, directory, port = 0 }) {
  const store = new ReceiptStore(directory);
  const inventories = new InventoryStore(directory);
  const boundedNumber = (url, name) => {
    const raw = url.searchParams.get(name);
    if (raw === null) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new Error(`参数 ${name} 无效`);
    return value;
  };
  return listen(async url => {
    if (url.pathname === '/health') return { body: { state: 'ready' } };
    if (url.pathname === '/inspect') {
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: result };
    }
    if (url.pathname === '/receive') {
      const key = url.searchParams.get('key') ?? 'single';
      const result = await inspect(source, Object.fromEntries(url.searchParams));
      return { body: await store.save(key, result) };
    }
    if (url.pathname === '/collect') {
      const result = await collectTable(source, {
        limit: boundedNumber(url, 'limit'),
        maxAttempts: boundedNumber(url, 'maxAttempts'),
        loadState: () => inventories.readState(),
        saveState: state => inventories.writeState(state),
      });
      if (result.status !== 'complete') return { body: result };
      const previous = await inventories.readInventory();
      const changes = previous ? diffInventories(previous, result) : null;
      await inventories.writeInventory(result);
      return { body: { inventory: result, changes } };
    }
    if (url.pathname.startsWith('/receipts/')) return { body: await store.read(url.pathname.split('/').pop()) };
    return { status: 404, body: { error: '接口不存在' } };
  }, port);
}
