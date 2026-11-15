/**
 * The field probe, against a fake connector: what it searches, which fields it
 * picks out of the rows, and that it stays inside its budget and cache.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');

const { FieldProbeService } = require(join(__dirname, '..', '..', 'dist/modules/enrichment/field-probe.service'));

const ROWS = [
  { _raw: '... "GET /UpLoads/php-webshell.php HTTP/1.1" ...', _time: '1735058798', index: 'main',
    sourcetype: 'access_combined', file: 'php-webshell.php', uri_path: '/UpLoads/php-webshell.php', status: '200' },
  { _raw: '...', file: 'PHP-WEBSHELL.PHP', uri_path: '/uploads/php-webshell.php', status: '404' },
];

function setup(settings = {}) {
  const searched = [];
  let connects = 0;
  const session = {
    run: async (spl) => {
      searched.push(spl);
      return settings.noRunTool ? null : ROWS;
    },
    close: async () => undefined,
  };
  const splunk = { connect: async () => { connects += 1; return session; } };
  const values = { 'lookup.fieldProbe': true, 'lookup.maxProbes': 3, 'lookup.probeCacheMs': 3_600_000, ...settings.config };
  const probe = new FieldProbeService({ get: (k) => values[k] }, splunk);
  return { probe, searched, connects: () => connects };
}

const item = (over = {}) => ({
  requirement: 'Is there evidence of php-webshell.php',
  indicator: 'php-webshell.php',
  indicatorType: 'file',
  alertIndex: 'main',
  alertSourcetype: 'access_combined',
  unscoped: true,
  fields: [],
  fieldHints: [{ value: '192.168.56.129', fields: ['clientip'] }],
  earliest: '2024-12-23T16:46:38Z',
  latest: '2024-12-24T17:46:38Z',
  ...over,
});

test('aims an unaimed item at the field that holds the value exactly', async () => {
  const { probe, searched } = setup();
  const plan = [item()];
  assert.equal(await probe.aimUnaimed('job', plan, {}), 1);
  assert.deepEqual(plan[0].fields, ['file']); // not uri_path: it only contains the value
  assert.equal(plan[0].unscoped, false);
  assert.equal(plan[0].aimedBy, 'probe');
  assert.equal(plan[0].index, 'main');
  assert.equal(plan[0].sourcetype, 'access_combined');
  assert.deepEqual(plan[0].fieldHints[0], { value: 'php-webshell.php', fields: ['file'] });
  assert.equal(
    searched[0],
    'search index="main" sourcetype="access_combined" "php-webshell.php" earliest=1734972398 latest=1735062398 | head 20 | fields *',
  );
});

test('one probe per sourcetype and type, then the cache', async () => {
  const { probe, searched, connects } = setup();
  await probe.aimUnaimed('job1', [item()], {});
  const plan = [item({ indicator: 'shell2.php' })];
  assert.equal(await probe.aimUnaimed('job2', plan, {}), 1);
  assert.deepEqual(plan[0].fields, ['file']);
  assert.equal(searched.length, 1);
  assert.equal(connects(), 1);
});

test('stays within the per-job budget', async () => {
  const { probe, searched } = setup({ config: { 'lookup.maxProbes': 1 } });
  const plan = [item(), item({ indicatorType: 'domain', indicator: 'evil.example' })];
  await probe.aimUnaimed('job', plan, {});
  assert.equal(searched.length, 1);
  assert.equal(plan[1].unscoped, true);
});

test('leaves aimed, playbook and index-less items alone', async () => {
  const { probe, searched } = setup();
  const plan = [
    item({ unscoped: false, fields: ['file'] }),
    item({ filters: { status: '200' } }),
    item({ alertIndex: undefined }),
  ];
  assert.equal(await probe.aimUnaimed('job', plan, {}), 0);
  assert.equal(searched.length, 0);
});

test('off, or a connector without splunk_run_query, changes nothing', async () => {
  const off = setup({ config: { 'lookup.fieldProbe': false } });
  const plan = [item()];
  assert.equal(await off.probe.aimUnaimed('job', plan, {}), 0);
  assert.equal(plan[0].unscoped, true);

  const old = setup({ noRunTool: true });
  assert.equal(await old.probe.aimUnaimed('job', plan, {}), 0);
  assert.equal(plan[0].unscoped, true);
});
