// Never listens: initialisation must fail at the readiness deadline.
console.log('booting, but never listening');
setInterval(() => undefined, 1000);
