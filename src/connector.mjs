import { get } from './http.mjs';
export function oidCompare(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    if (index === leftParts.length) return -1;
    if (index === rightParts.length) return 1;
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}
export async function inspect(base, options = {}) {
  return (await get(base, '/bulk?after=' + encodeURIComponent(options.after ?? '1.3.6.1.4.1.900.1') + '&limit=2')).json();
}
