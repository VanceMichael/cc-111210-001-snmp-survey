import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID();
  await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
  await rename(temporary, path);
}

// 设备清单与断点续采状态的落盘：清单原子替换，扫描状态在列边界更新
export class InventoryStore {
  constructor(directory) {
    this.inventoryPath = join(directory, 'inventory.json');
    this.statePath = join(directory, 'scan-state.json');
  }
  readInventory() { return readJsonFile(this.inventoryPath); }
  writeInventory(inventory) { return writeJsonFile(this.inventoryPath, inventory); }
  readState() { return readJsonFile(this.statePath); }
  async writeState(state) {
    if (state === null) await rm(this.statePath, { force: true });
    else await writeJsonFile(this.statePath, state);
  }
}

export class ReceiptStore {
  constructor(directory) { this.directory = directory; }
  async save(key, value) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key)) throw new Error('接收标识无效');
    await mkdir(this.directory, { recursive: true });
    const payload = JSON.stringify(value);
    const receipt = { key, digest: digest(payload), value };
    const path = join(this.directory, key + '.json');
    try {
      const existing = JSON.parse(await readFile(path, 'utf8'));
      if (existing.digest !== receipt.digest) throw new Error('接收内容冲突');
      return existing;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const temporary = path + '.' + randomUUID();
    await writeFile(temporary, JSON.stringify(receipt, null, 2), { flag: 'wx' });
    await rename(temporary, path);
    return receipt;
  }
  async read(key) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key)) throw new Error('接收标识无效');
    const receipt = JSON.parse(await readFile(join(this.directory, key + '.json'), 'utf8'));
    if (digest(JSON.stringify(receipt.value)) !== receipt.digest) throw new Error('接收记录校验失败');
    return receipt;
  }
}
