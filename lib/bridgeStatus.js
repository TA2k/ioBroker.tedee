'use strict';

/**
 * Network errors after which the bridge does not answer at all: wrong IP address
 * (e.g. changed by DHCP), bridge without power or WiFi, local API switched off.
 * Other errors (HTTP status, ECONNRESET) come from a reachable bridge.
 */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EADDRNOTAVAIL',
]);

/**
 * Checks whether a request failed because the bridge could not be reached.
 *
 * @param {unknown} error error of a request (axios error)
 * @returns {boolean} true: no answer from the bridge
 */
function isUnreachable(error) {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const { response, code } = /** @type {{ response?: unknown, code?: string }} */ (error);
  return !response && !!code && UNREACHABLE_CODES.has(code);
}

module.exports = { UNREACHABLE_CODES, isUnreachable };
