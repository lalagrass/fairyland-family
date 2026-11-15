let passed = 0, failed = 0;
export function assert(c: boolean, n: string): void {
  if (c) { console.log(`  ✓ PASS: ${n}`); passed++; } else { console.error(`  ✗ FAIL: ${n}`); failed++; }
}
export function suite(name: string): void { console.log(`Suite: ${name}`); }
export function done(): void {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
