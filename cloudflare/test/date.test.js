import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAuthorizationDate, isAuthorizationExpired, parseAuthorizationDate } from '../src/index.js';

test('normalizes supported authorization date formats', () => {
  assert.equal(formatAuthorizationDate('2026-07-14'), '2026/7/14');
  assert.equal(formatAuthorizationDate('2026/7/14'), '2026/7/14');
  assert.equal(formatAuthorizationDate('2026.7.14'), '2026/7/14');
  assert.equal(parseAuthorizationDate('2026/2/30'), null);
});

test('expires only after the one-year anniversary', () => {
  assert.equal(isAuthorizationExpired('2025/7/14', new Date('2026-07-14T04:00:00Z')), false);
  assert.equal(isAuthorizationExpired('2025/7/13', new Date('2026-07-14T04:00:00Z')), true);
});