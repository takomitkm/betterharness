const refs = [];
export function useRef(v) {
  // 真实 React：useRef 跨渲染返回同一对象（挂在 fiber hook 槽位上）
  const i = slotIdx++;
  if (!(i in refs)) refs[i] = { current: v };
  return refs[i];
}
export function useCallback(fn) { return fn; }
const slots = [];
let slotIdx = 0;
export function startRender() { slotIdx = 0; }
export function useState(initial) {
  const i = slotIdx++;
  if (!(i in slots)) slots[i] = initial;
  const set = (v) => { slots[i] = (typeof v === "function") ? v(slots[i]) : v; };
  return [slots[i], set];
}

export function __dump() { return slots; }
export const __slots = slots;
