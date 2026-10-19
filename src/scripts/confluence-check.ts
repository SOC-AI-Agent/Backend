/**
 * Can the worker read the playbook space? Run inside soc-core-worker, which has
 * the same .env, network, proxy and CA as the hourly sync, by the
 * check_confluence job in .gitlab-ci.yml:
 *
 *   docker exec soc-core-worker node dist/scripts/confluence-check.js
 *
 * Reads the whole space the way the sync does (PlaybookSyncService.readSpace:
 * same API, credentials, proxy and paging) and prints how many pages it found
 * and the first few titles. Read-only; sends nothing to soc-ai. The token is
 * never printed, nor a password in CONFLUENCE_PROXY.
 */
import { existsSync } from 'fs';

import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';

import configuration from '../config/configuration';
import { PlaybookSyncService } from '../modules/enrichment/playbook-sync.service';

/** What a failed connection means, by Node's error code. */
const HINTS: Record<string, string> = {
  ENOTFOUND: 'the name does not resolve from here (DNS); for Cloud, set CONFLUENCE_PROXY — the proxy resolves it',
  EAI_AGAIN: 'the name does not resolve from here (DNS); for Cloud, set CONFLUENCE_PROXY — the proxy resolves it',
  ETIMEDOUT: 'nothing answered: a firewall on the way, or Cloud without CONFLUENCE_PROXY',
  ECONNABORTED: 'no answer within the time allowed: a firewall on the way, or Cloud without CONFLUENCE_PROXY',
  ECONNREFUSED: 'the connection was refused: the wrong port, or (with CONFLUENCE_PROXY) the proxy is not at that address',
  ECONNRESET: 'the connection was cut: often a proxy or firewall that does not allow this host',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'the certificate is from a CA this container does not trust: NODE_EXTRA_CA_CERTS (a proxy that inspects HTTPS needs its own CA there)',
  SELF_SIGNED_CERT_IN_CHAIN: 'the certificate is from a CA this container does not trust: NODE_EXTRA_CA_CERTS (a proxy that inspects HTTPS needs its own CA there)',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'a self-signed certificate: its CA goes in NODE_EXTRA_CA_CERTS',
  CERT_HAS_EXPIRED: 'the certificate has expired',
  ERR_TLS_CERT_ALTNAME_INVALID: 'the certificate does not cover the name in CONFLUENCE_BASE_URL',
};

async function main(): Promise<void> {
  const config = new ConfigService(configuration());
  const c = config.get('playbook.confluence');
  const sync = new PlaybookSyncService(new HttpService(), config);

  let proxy = 'none — direct';
  if (c.proxy) {
    try {
      const u = new URL(c.proxy);
      proxy = `${u.protocol}//${u.host}${u.username ? ' (with credentials)' : ''}`;
    } catch {
      proxy = 'INVALID — CONFLUENCE_PROXY is not a URL like http://host:port';
    }
  }
  const ca = process.env.NODE_EXTRA_CA_CERTS;
  console.log(`base URL       ${c.baseUrl || 'NOT SET'}`);
  console.log(`API            ${sync.apiVersion()}${c.api === 'auto' ? ' (auto)' : ''}`);
  console.log(`space          ${c.spaceKey || 'NOT SET'}`);
  console.log(`credentials    ${c.email ? `email ${c.email} + API token (basic)` : 'personal access token (bearer)'}; ` +
    `token ${c.apiToken ? `set (${c.apiToken.length} chars)` : 'NOT SET'}`);
  console.log(`proxy          ${proxy}`);
  console.log(`extra CA       ${ca ? `${ca} (${existsSync(ca) ? 'found' : 'MISSING'})` : 'none'}`);

  if (!c.baseUrl || !c.apiToken || !c.spaceKey) {
    throw new Error('CONFLUENCE_BASE_URL, CONFLUENCE_API_TOKEN and CONFLUENCE_SPACE_KEY must all be set (CI variables): the sync is off');
  }

  const started = Date.now();
  const pages = await sync.readSpace(Math.min(config.get('playbook.syncTimeoutMs'), 60_000));
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`read           ${pages.length} page(s) in ${secs} s`);
  for (const p of pages.slice(0, 5)) console.log(`               ${p.title}  (${p.url})`);
  if (pages.length > 5) console.log(`               … and ${pages.length - 5} more`);
  if (!pages.length) console.log('               the space is empty, or the account sees none of it');
}

main().catch((err) => {
  const code: string | undefined = err?.code ?? err?.cause?.code;
  console.error(`FAILED: ${err?.message ?? err}${code ? ` [${code}]` : ''}`);
  if (code && HINTS[code]) console.error(`               ${HINTS[code]}`);
  process.exit(1);
});
