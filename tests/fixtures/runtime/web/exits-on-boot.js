// Crashes during initialisation, before listening — by exit code, or by a
// signal when BOOT_SIGNAL is set.
console.error('boom: cannot start');
if (process.env.BOOT_SIGNAL) process.kill(process.pid, process.env.BOOT_SIGNAL);
else process.exit(3);
