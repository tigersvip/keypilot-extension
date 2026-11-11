import test from 'node:test';
import assert from 'node:assert/strict';
import { sameLoginTarget, isCertificateError, loginJobActive } from '../src/shared/loginJob';

test('login continuation is origin-bound and only allows an explicit default-port HTTPS upgrade', () => {
  assert.equal(sameLoginTarget('https://example.test', 'https://example.test/login?next=home'), true);
  for (const url of ['http://example.test', 'https://example.test:8443', 'https://sub.example.test', 'https://example.test.evil.test', 'https://user:pass@example.test', 'chrome-error://chromewebdata/', 'not a url']) {
    assert.equal(sameLoginTarget('https://example.test', url, true), false, url);
  }
  assert.equal(sameLoginTarget('http://example.test', 'https://example.test'), false);
  assert.equal(sameLoginTarget('http://example.test', 'https://example.test', true), true);
  assert.equal(sameLoginTarget('http://example.test:8080', 'https://example.test:8080', true), false);
  assert.equal(sameLoginTarget('chrome://settings', 'chrome://settings'), false);
});

test('certificate failures are distinguished from network failures and abandoned navigation', () => {
  for (const error of ['net::ERR_CERT_AUTHORITY_INVALID', 'net::ERR_CERT_DATE_INVALID', 'net::ERR_CERT_COMMON_NAME_INVALID', 'net::ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN']) assert.equal(isCertificateError(error), true);
  for (const error of ['net::ERR_ABORTED', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_NAME_NOT_RESOLVED', 'ERR_CERT_DATE_INVALID', 'net::ERR_SSL_PROTOCOL_ERROR']) assert.equal(isCertificateError(error), false);
});

test('terminal login jobs never resume', () => {
  for (const phase of ['loading', 'certificate', 'locked', 'filling'] as const) assert.equal(loginJobActive({phase}), true);
  for (const phase of ['done', 'failed', 'cancelled', 'expired'] as const) assert.equal(loginJobActive({phase}), false);
});
