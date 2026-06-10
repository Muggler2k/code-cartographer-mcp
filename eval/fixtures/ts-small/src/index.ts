import { add } from "./math.js";

export function main(): number {
  return add(1, 2);
}

export function dyn(o: Record<string, () => void>): void {
  o["pluginHook"]();
}
