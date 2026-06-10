import { ping } from "./cycleA.js";

export function pong(n: number): number {
  return ping(n);
}
