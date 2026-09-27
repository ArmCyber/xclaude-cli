const cell = new Int32Array(new SharedArrayBuffer(4));

/** Blocks the thread; used while polling locks from synchronous code. */
export function sleepSync(ms: number): void {
  Atomics.wait(cell, 0, 0, ms);
}
