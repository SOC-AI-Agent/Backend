/**
 * MISP answers read as ThreatQ-shaped records (MispService's toRecord), and a
 * value MISP has never seen stays "not found" — never clean.
 *
 * Runs against the build: npm run test:unit
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');

const { toRecord } = require(join(__dirname, '..', '..', 'dist', 'modules', 'enrichment', 'misp.service'));

test('no attribute is not found, not clean', () => {
  assert.deepEqual(toRecord('ip', '198.51.100.7', []), { value: '198.51.100.7', type: 'ip', found: false });
});

test('an attribute gives verdict, threat level, event and context', () => {
  const r = toRecord('ip', '45.83.122.9', [{
    id: '12', event_id: '3', category: 'Network activity', type: 'ip-dst', to_ids: true,
    comment: 'C2 server, HTTPS beacon every 60 s', timestamp: '1794934007', first_seen: null,
    Event: { info: 'SOC Lab - corp.local intrusion', threat_level_id: '1', date: '2024-12-24' },
    Tag: [{ name: 'soc-lab:verdict="malicious"' }, { name: 'tlp:amber' }, { name: 'misp-galaxy:threat-actor="Lab-APT"' }],
  }]);
  assert.equal(r.found, true);
  assert.equal(r.score, 'threat level High');
  assert.equal(r.status, 'malicious; flagged for detection (to_ids)');
  assert.deepEqual(r.sources, ['MISP event 3: SOC Lab - corp.local intrusion']);
  assert.deepEqual(r.adversaries, ['Lab-APT']);
  assert.match(r.context, /C2 server/);
  assert.match(r.context, /tag tlp:amber/);
  assert.doesNotMatch(r.context, /verdict/);
  // The event's date, not the record's edit timestamp.
  assert.equal(r.first_seen, '2024-12-24');
});

test('context-only attribute says so', () => {
  const r = toRecord('domain', 'example.org', [{ id: '1', event_id: '9', to_ids: false, Tag: [] }]);
  assert.equal(r.status, 'context only (not to_ids)');
  assert.equal(r.score, undefined);
});
