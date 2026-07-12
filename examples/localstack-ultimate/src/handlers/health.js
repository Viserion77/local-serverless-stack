const respond = require('./respond');

exports.handler = async () => respond(200, { ok: true, service: 'localstack-ultimate', ts: Date.now() });
