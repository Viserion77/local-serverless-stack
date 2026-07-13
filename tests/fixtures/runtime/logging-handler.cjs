// Fixture for the runtime-worker fork test: emits output through every layer
// a real handler might use — console.*, process.stdout.write and raw fd
// writes (the sonic-boom/pino path) — so the test proves each one lands in
// the invocation's captured logs.
const fs = require('fs');

console.log('module init log');

exports.handler = async () => {
  console.log('hello from console', 42);
  console.error('tagged error');
  process.stdout.write('direct stdout write\n');
  await new Promise((resolve) => {
    fs.write(1, JSON.stringify({ level: 30, msg: 'pino-style fd write' }) + '\n', resolve);
  });
  fs.writeSync(1, 'sync fd write\n');
  fs.writeSync(2, 'stderr fd write\n');
  process.stdout.write('partial ');
  process.stdout.write('line reassembled\n');
  return { statusCode: 500, body: JSON.stringify({ error: 'internal_error' }) };
};

exports.orphan = async () => {
  setTimeout(() => {
    process.stdout.write('orphan line after completion\n');
  }, 150);
  return { ok: true };
};

// Pair used by the interleaved-attribution test: `slow` stays in flight while
// `quick` runs to completion inside it.
exports.slow = async (event) => {
  console.log('slow-start');
  fs.writeSync(1, 'slow-fd-line\n');
  await new Promise((resolve) => setTimeout(resolve, (event && event.holdMs) || 400));
  console.log('slow-end');
  return { tag: 'slow' };
};

exports.quick = async () => {
  console.log('quick-line');
  fs.writeSync(1, 'quick-fd-line\n');
  return { tag: 'quick' };
};
