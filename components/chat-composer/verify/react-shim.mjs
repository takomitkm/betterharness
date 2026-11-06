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
  // React 惯例：initial 为函数时惰性求值（lazy initializer）
  if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
  const set = (v) => { slots[i] = (typeof v === "function") ? v(slots[i]) : v; };
  return [slots[i], set];
}

export function __dump() { return slots; }
export const __slots = slots;

// 测试专用：模拟组件卸载后重新挂载（hooks 槽位与 refs 全部归零）
export function __resetSlots() {
  slots.length = 0;
  refs.length = 0;
  slotIdx = 0;
}
