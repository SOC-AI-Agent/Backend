/**
 * Holding the agents to the playbook: how it is shown (PlaybookService.render),
 * how a reply is checked (ai/grounding), the one retry (AiService.generateGrounded),
 * requirements tied to runbook steps, and the detection SPL's scope.
 *
 * Runs against the build: npm run test:unit
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');

const DIST = join(__dirname, '..', '..', 'dist', 'modules');
const { checkGrounding, correctionPrompt, passages, stepsOf } = require(join(DIST, 'ai/grounding'));
const { parseRequirements, requirementsFormat } = require(join(DIST, 'ai/requirements'));
const { AiService } = require(join(DIST, 'ai/ai.service'));
const { PlaybookService } = require(join(DIST, 'enrichment/playbook.service'));

const PLAYBOOK = {
  page_id: '601',
  alert_name: 'Suspicious IP Callback',
  use_case_id: 'UC-CAT-012',
  version: '3',
  rule_description: 'A client connects to an address ThreatQ lists as command and control',
  true_condition: 'The destination is on the ThreatQ block list',
  false_condition: 'The destination is the company proxy',
  steps: [
    'Check the source IP against the scanner list',
    'Search firewall logs for the source IP in the last 24 hours',
    'Escalate to Tier 2 when the account is privileged',
  ],
  target_audience: 'SOC Tier 1',
  contact: 'soc-lead@example.com',
  detection_spl: 'index=fortigate sourcetype=fgt_traffic action=blocked',
  detection_scope: { index: ['fortigate'], sourcetype: ['fgt_traffic'] },
};
const MATCH = { matched: true, how: 'id', playbook: PLAYBOOK };
const NONE = { matched: false, how: 'miss', note: 'No playbook covers an alert named "X".' };

// ── Passages ────────────────────────────────────────────────────────────────

test('passages: every part of the playbook has a tag, in reading order', () => {
  assert.deepEqual(passages(PLAYBOOK).map((p) => p.id), [
    'PB:description', 'PB:true', 'PB:false', 'PB:step 1', 'PB:step 2', 'PB:step 3', 'PB:contact', 'PB:spl',
  ]);
});

test('stepsOf: an AI service without `steps` still gives numbered steps', () => {
  assert.deepEqual(stepsOf({ work_around: '1. Check A\n2) Check B\n\n- Check C' }), ['Check A', 'Check B', 'Check C']);
});

// ── Checking a reply ────────────────────────────────────────────────────────

test('a verdict resting on the cited condition is grounded', () => {
  const r = checkGrounding(
    'The destination 203.0.113.9 is on the block list, so this is a true positive [PB:true].\n' +
      'Next: [PB:step 2] search the firewall logs.',
    MATCH,
  );
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.deepEqual(r.cited, ['PB:true', 'PB:step 2']);
  assert.deepEqual(r.verdicts, ['true_positive']);
});

test('a verdict with nothing cited is caught', () => {
  const r = checkGrounding('Verdict: True Positive. The host looks compromised.', MATCH);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /without citing/);
});

test('a step the playbook does not have is caught', () => {
  const r = checkGrounding('Isolate the host [PB:step 7].', MATCH);
  assert.deepEqual(r.unknownCitations, ['PB:step 7']);
  assert.match(r.problems[0], /does not have/);
});

test('a quote the playbook does not contain is caught; a real one is not', () => {
  const made = checkGrounding('The playbook says "any connection to Russia is malicious" [PB:true].', MATCH);
  assert.equal(made.ok, false);
  assert.deepEqual(made.unsupportedQuotes, ['any connection to Russia is malicious']);

  const real = checkGrounding('Per the runbook: “The destination is the company proxy.” [PB:false]', MATCH);
  assert.equal(real.ok, true, real.problems.join('; '));
});

test('with no playbook, a verdict is a problem', () => {
  const r = checkGrounding('This is likely a false positive.', NONE);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /no playbook covers this alert/);
});

test('with no playbook, saying the verdict needs an analyst is fine', () => {
  const r = checkGrounding(
    'No playbook covers this alert, so whether it is a true or false positive needs an analyst.',
    NONE,
  );
  assert.equal(r.ok, true, r.problems.join('; '));
});

test('with no playbook, citing one is a problem', () => {
  const r = checkGrounding('Escalate per [PB:step 1].', null);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unknownCitations, ['PB:step 1']);
});

test('both verdicts at once is a problem', () => {
  const r = checkGrounding('It is a true positive [PB:true]. Verdict: false positive [PB:false].', MATCH);
  assert.ok(r.problems.some((p) => /both/.test(p)));
});

test('the correction names each problem and keeps the prompt', () => {
  const r = checkGrounding('Verdict: TP.', MATCH);
  const prompt = correctionPrompt('THE PROMPT', 'Verdict: TP.', r);
  assert.ok(prompt.startsWith('THE PROMPT'));
  assert.ok(prompt.includes(r.problems[0]));
  assert.ok(prompt.includes('Verdict: TP.'));
});

// ── The retry ───────────────────────────────────────────────────────────────

function aiWith(replies, retry = true) {
  const config = { get: (key) => (key === 'ai.groundingRetry' ? retry : undefined) };
  const ai = new AiService({}, config);
  const prompts = [];
  ai.generate = async (prompt) => {
    prompts.push(prompt);
    const response = replies.shift();
    return { response, model: 'm', total_duration_ms: 10, tokens_prompt: 100, tokens_eval: 20, run_id: null };
  };
  return { ai, prompts };
}

test('a reply that breaks the rules is asked again once, and the fixed one kept', async () => {
  const { ai, prompts } = aiWith(['Verdict: true positive.', 'Verdict: true positive [PB:true].']);
  const { result, grounding } = await ai.generateGrounded('P', { agent: 'soc-suggest' }, MATCH);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /--- CORRECTION ---/);
  assert.equal(result.response, 'Verdict: true positive [PB:true].');
  assert.equal(result.tokens_prompt, 200);
  assert.equal(grounding.ok, true);
  assert.equal(grounding.retried, true);
});

test('a grounded reply is not asked again', async () => {
  const { ai, prompts } = aiWith(['Escalate [PB:step 3].']);
  const { grounding } = await ai.generateGrounded('P', {}, MATCH);
  assert.equal(prompts.length, 1);
  assert.equal(grounding.retried, undefined);
});

test('with the retry off, the reply is kept and flagged', async () => {
  const { ai, prompts } = aiWith(['Verdict: true positive.'], false);
  const { grounding } = await ai.generateGrounded('P', {}, MATCH);
  assert.equal(prompts.length, 1);
  assert.equal(grounding.ok, false);
});

test('an empty retry keeps the first reply', async () => {
  const { ai } = aiWith(['Verdict: true positive.', '   ']);
  const { result } = await ai.generateGrounded('P', {}, MATCH);
  assert.equal(result.response, 'Verdict: true positive.');
});

// ── Requirements from the runbook ───────────────────────────────────────────

const KNOWN = [{ type: 'ip', value: '10.1.100.44', source: 'log' }];

test('the format asks for steps only when the playbook has some', () => {
  assert.match(requirementsFormat(5, 3), /\[PB:step 1\] to \[PB:step 3\]/);
  assert.doesNotMatch(requirementsFormat(5, 0), /PB:step/);
});

test('a requirement says which step it serves; a step that does not exist is dropped', () => {
  const reply = [
    '1. What did 10.1.100.44 connect to in the last 24 hours',
    '   step: 2',
    '   source: 10.1.100.44',
    '2. Is 10.1.100.44 a scanner',
    '   step: 9',
    '3. Which accounts logged in from 10.1.100.44 [PB:step 3]',
  ].join('\n');
  const [first, second, third] = parseRequirements(reply, KNOWN, 5, 'source 10.1.100.44', 3);
  assert.equal(first.playbookStep, 2);
  assert.deepEqual(first.context, { source: '10.1.100.44' });
  assert.equal(second.playbookStep, undefined);
  assert.match(second.droppedContext[0], /step: 9/);
  assert.equal(third.playbookStep, 3);
  assert.equal(third.requirement, 'Which accounts logged in from 10.1.100.44');
});

// ── The playbook as the agents read it, and the detection SPL's scope ───────

function service(catalog = { loaded: false }) {
  return new PlaybookService({}, { get: () => ({}) }, catalog, { stale: false });
}

test('render: tagged passages and the rules under them', () => {
  const text = service().render(MATCH);
  assert.match(text, /Matched by use case id UC-CAT-012/);
  assert.match(text, /\[PB:true\] TRUE POSITIVE when: The destination is on the ThreatQ block list/);
  assert.match(text, /\[PB:step 2\] Step 2: Search firewall logs/);
  assert.match(text, /\[PB:spl\] .*it is not run/);
  assert.match(text, /cited \[PB:step 1\] to \[PB:step 3\]/);
  assert.match(text, /--- END OF PLAYBOOK ---$/);
});

test('render: no playbook means no verdict', () => {
  const text = service().render(NONE);
  assert.match(text, /Do not give a verdict/);
  assert.doesNotMatch(text, /\[PB:true\]/);
});

const CATALOG = {
  loaded: true,
  indexNames: () => ['main', 'fortigate'],
  sourcetypeNames: (i) => (i === 'fortigate' ? ['fgt_traffic', 'fgt_event'] : ['sysmon']),
};

test('fillSource: an unplaced alert is placed by the detection SPL', () => {
  const hint = service(CATALOG).fillSource({ unknown: true, from: 'nothing matched' }, MATCH);
  assert.equal(hint.index, 'fortigate');
  assert.equal(hint.sourcetype, 'fgt_traffic');
  assert.match(hint.from, /detection SPL/);
});

test("fillSource: the alert's own index wins", () => {
  const own = { index: 'main', sourcetype: 'sysmon', from: 'orig_index' };
  assert.equal(service(CATALOG).fillSource(own, MATCH), own);
});

test('fillSource: an index the catalogue does not list is not used', () => {
  const stale = { ...MATCH, playbook: { ...PLAYBOOK, detection_scope: { index: ['old_fw'], sourcetype: [] } } };
  const unknown = { unknown: true, from: 'nothing matched' };
  assert.equal(service(CATALOG).fillSource(unknown, stale), unknown);
});

test("fillSource: a near match's SPL is another detection's, and not used", () => {
  const unknown = { unknown: true, from: 'nothing matched' };
  assert.equal(service(CATALOG).fillSource(unknown, { ...MATCH, how: 'semantic' }), unknown);
});
