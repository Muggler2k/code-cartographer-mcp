import { pong } from "./cycleB.js";

export function ping(n: number): number {
  return n <= 0 ? 0 : pong(n - 1);
}
