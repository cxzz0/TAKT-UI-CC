'use strict';
const { timingSafeEqual } = require('node:crypto');

function isLoopbackHost(host) {
  try {
    const url = new URL(`http://${host}`);
    return !url.username && !url.password && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

function isLocalOrigin(origin, port) {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && isLoopbackHost(url.host) && Number(url.port || 80) === port;
  } catch { return false; }
}

function hasBearerToken(headers, token) {
  const auth = String(headers.authorization || '');
  const supplied = Buffer.from(auth.startsWith('Bearer ') ? auth.slice(7) : '');
  const expected = Buffer.from(token);
  return expected.length > 0 && supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

module.exports = { isLoopbackHost, isLocalOrigin, hasBearerToken };
