export function add(a: number, b: number): number {
  return normalize(a) + b;
}

function normalize(a: number): number {
  return a | 0;
}
