/**
 * Is the Splunk MCP endpoint usable by stage 2? Run inside soc-core-worker, which
 * has the same .env, network and CA as the lookups, by two jobs in .gitlab-ci.yml:
 * check_splunk after every deploy with no argument, and check_splunk_requirement
 * (manual) with SPLUNK_CHECK_REQUIREMENT as the argument:
 *
 *   docker exec soc-core-worker node dist/scripts/splunk-mcp-check.js
 *   docker exec soc-core-worker node dist/scripts/splunk-mcp-check.js "Failed logins in the last hour"
 *
 * Without an argument it connects, lists the tools and says which argument of the
 * Text-to-SPL tool takes the request. With one, it also sends that requirement
 * through the same path a lookup does — generate, check, run — and prints the SPL
 * and the rows. Read-only either way. The token is never printed.
 */
import { existsSync } from 'fs';

import { ConfigService } from '@nestjs/config';

import configuration from '../config/configuration';
import { SplunkMcpService } from '../modules/enrichment/splunk-mcp.service';

async function main(): Promise<void> {
  const config = new ConfigService(configuration());
  const splunk = config.get('splunk');
  const requirement = process.argv.slice(2).join(' ').trim();

  console.log(`endpoint       ${splunk.mcpUrl}`);
  console.log(`token          ${splunk.token ? `set (${splunk.token.length} chars)` : 'NOT SET'}`);
  console.log(`tools          ${splunk.generateTool}, ${splunk.queryTool}`);
  // Node only warns at start-up when this file is missing, then carries on without it — and
  // every TLS error after that looks like a bad certificate rather than a missing file.
  const ca = process.env.NODE_EXTRA_CA_CERTS;
  console.log(`extra CA       ${ca ? `${ca} (${existsSync(ca) ? 'found' : 'MISSING — not used; in production the file is under /app/certs'})` : 'none'}`);

  const service = new SplunkMcpService(config);
  const session = await service.connect();
  try {
    console.log(`connected      yes — both tools found; Text-to-SPL takes the request in "${session.promptArg}"`);
    if (!requirement) return;

    const answer = await session.ask({ requirement });
    console.log(`\nprompt sent    ${answer.prompt.replace(/\n/g, ' / ')}`);
    console.log(service.render(answer));
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error(`FAILED: ${err?.message ?? err}`);
  process.exit(1);
});
