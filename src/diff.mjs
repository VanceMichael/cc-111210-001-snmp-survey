import { oidCompare } from './connector.mjs';
import { COLUMNS } from './walk.mjs';

function cellValue(cell) {
  return cell && cell.status !== 'missing' ? cell.value : null;
}

function counterChange(before, after, width, restarted) {
  const previous = cellValue(before);
  const current = cellValue(after);
  const base = { previous, current };
  if (restarted) return { ...base, delta: null, reason: '设备启动标识变化，计数器差值不适用' };
  if (previous === null || current === null) return { ...base, delta: null, reason: '计数器单元格缺失，无法计算差值' };
  let former;
  let latter;
  try {
    former = BigInt(previous);
    latter = BigInt(current);
  } catch {
    return { ...base, delta: null, reason: '计数器值不是整数' };
  }
  if (latter >= former) return { ...base, delta: (latter - former).toString(), wrap: false };
  if (width === null || width === undefined) return { ...base, delta: null, reason: '计数器回退且位宽缺失，无法确认回绕' };
  const modulus = 1n << BigInt(width);
  return { ...base, delta: ((modulus - former) + latter).toString(), wrap: true, width };
}

// 比对两轮清单：稳定接口按完整 OID 后缀对齐，解释新增、移除与计数器变化。
// 跨重启或无法确认回绕时不生成差值，避免虚假流量。
export function diffInventories(previous, current, columns = COLUMNS) {
  const restarted = previous.scan.boot !== current.scan.boot;
  const widthName = (columns.find(column => column.kind === 'width') ?? {}).name ?? 'width';
  const added = [];
  const removed = [];
  const stable = {};
  const suffixes = [...new Set([...Object.keys(previous.rows), ...Object.keys(current.rows)])].sort(oidCompare);
  for (const suffix of suffixes) {
    const before = previous.rows[suffix];
    const after = current.rows[suffix];
    if (!before) { added.push(suffix); continue; }
    if (!after) { removed.push(suffix); continue; }
    const width = cellValue(after.cells[widthName]) ?? cellValue(before.cells[widthName]);
    const changes = {};
    for (const column of columns) {
      if (column.kind === 'counter') {
        changes[column.name] = counterChange(before.cells[column.name], after.cells[column.name], width, restarted);
      } else {
        const a = cellValue(before.cells[column.name]);
        const b = cellValue(after.cells[column.name]);
        const entry = { previous: a, current: b, changed: a !== b };
        if (a === null || b === null) entry.missing = a === null ? (b === null ? 'both' : 'previous') : 'current';
        changes[column.name] = entry;
      }
    }
    stable[suffix] = changes;
  }
  const notes = [];
  if (restarted) notes.push('设备启动标识变化，所有计数器差值置空以避免虚假流量');
  if (added.length) notes.push(`新增接口：${added.join(', ')}`);
  if (removed.length) notes.push(`移除接口：${removed.join(', ')}`);
  return {
    restarted,
    boot: { previous: previous.scan.boot, current: current.scan.boot },
    added,
    removed,
    stable,
    notes,
  };
}
