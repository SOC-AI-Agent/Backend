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
 *
 * With --network (deploy_production's last step) it only asks whether
 * Confluence answers, sending no credentials at all: the name, the proxy, the
 * certificate and the path, before anything about the account.
 *
 * With --samples N, after the read: N of the pages (playbooks first), each
 * with whether soc-ai will take it as a playbook and the start of its text as
 * Confluence renders it for export. Printed only; nothing is written or kept.
 */
import { existsSync } from 'fs';

import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';

import configuration from '../config/configuration';
import { PlaybookPage, PlaybookSyncService } from '../modules/enrichment/playbook-sync.service';

/** A cell's or a page's text: tags out, entities decoded, blank lines dropped. */
function text(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

/**
 * The name soc-ai would route this page by: a two-column table row labelled as
 * soc-ai's extractor labels it (AI-Service playbooks/extract.py FIELD_LABELS).
 * None: soc-ai skips the page.
 */
function playbookName(storage: string): string | null {
  for (const row of storage.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => text(m[1]).replace(/\n/g, ' '));
    if (cells.length === 2 && /^(alert name|alert|use case|use case \/ alert name|use case name)$/i.test(cells[0])) {
      return cells[1] || null;
    }
  }
  return null;
}

/** Up to n pages, playbooks first, printed. */
async function samples(sync: PlaybookSyncService, pages: PlaybookPage[], n: number, timeoutMs: number): Promise<void> {
  const named = pages.map((p) => ({ page: p, name: playbookName(p.body) }));
  const picks = [...named.filter((x) => x.name), ...named.filter((x) => !x.name && x.page.body.trim())].slice(0, n);
  const playbooks = named.filter((x) => x.name).length;
  console.log(`playbooks      ${playbooks} of ${pages.length} page(s) have a Use Case / Alert Name row soc-ai routes by`);
  let i = 0;
  for (const { page, name } of picks) {
    i += 1;
    console.log(`\nsample ${i}       ${page.title}  (${page.url})`);
    console.log(`               ${name ? `playbook: yes — routed by "${name}"` : 'playbook: no — no Use Case / Alert Name row, soc-ai skips it'}`);
    let html = '';
    try {
      html = await sync.pageExportHtml(page.id, timeoutMs);
    } catch (err: any) {
      console.log(`               (no export view: ${err?.message ?? err} — the storage format instead)`);
    }
    const lines = text((html || page.body).replace(/<img\b[^>]*>/gi, '[image]')).split('\n');
    for (const line of lines.slice(0, 20)) console.log(`               | ${line.slice(0, 160)}`);
    if (lines.length > 20) console.log(`               | … ${lines.length - 20} more line(s)`);
  }
  if (!picks.length) console.log('samples        none: no page has a body');
}

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
  const scope = c.rootType && sync.apiVersion() === 'v2'
    ? `${c.rootType} ${c.rootId} and every page under it`
    : `the whole space${c.rootType ? ` (a ${c.rootType} in the URL narrows it only on Cloud, API v2)` : ''}`;
  console.log(`reads          ${scope}`);
  console.log(`credentials    ${c.email ? `email ${c.email} + API token (basic)` : 'personal access token (bearer)'}; ` +
    `token ${c.apiToken ? `set (${c.apiToken.length} chars)` : 'NOT SET'}`);
  console.log(`proxy          ${proxy}`);
  console.log(`extra CA       ${ca ? `${ca} (${existsSync(ca) ? 'found' : 'MISSING'})` : 'none'}`);

  if (process.argv.includes('--network')) {
    if (!c.baseUrl) {
      console.log('network        CONFLUENCE_BASE_URL is not set: nothing to check');
      return;
    }
    // Unauthenticated, Confluence may say 401 before it says the path is wrong:
    // the one path Cloud has is checked here instead.
    const site = new URL(c.baseUrl);
    if (site.hostname.endsWith('.atlassian.net') && !site.pathname.replace(/\/+$/, '').endsWith('/wiki')) {
      console.log(`warning        a Cloud address ends in /wiki: CONFLUENCE_BASE_URL=${site.origin}/wiki`);
    }
    const r = await sync.reach(20_000);
    console.log(`network        reached ${new URL(r.url).host}${c.proxy ? ' through the proxy' : ''}: HTTP ${r.status} (no credentials sent)`);
    if (r.status === 401 || r.status === 403) {
      console.log('               Confluence answers and asks who is calling: network, proxy, certificate and path are fine');
    } else if (r.status === 200 && !r.html) {
      console.log('               Confluence answers (anonymous access is on): network, proxy, certificate and path are fine');
    } else if (r.status >= 300 && r.status < 400) {
      console.log(`               redirected${r.location ? ` to ${r.location}` : ''}: a login page in front of the API? check CONFLUENCE_BASE_URL`);
    } else if (r.status === 404) {
      console.log('               nothing at this path: CONFLUENCE_BASE_URL should be https://<org>.atlassian.net/wiki (Cloud) or the site root (Server/DC)');
    } else if (r.status === 407) {
      console.log('               the proxy wants credentials of its own: CONFLUENCE_PROXY=http://user:pass@host:port');
    } else {
      console.log(`               not an answer Confluence's API gives${r.html ? ' (a web page)' : ''}: check CONFLUENCE_BASE_URL`);
    }
    return;
  }

  if (!c.baseUrl || !c.apiToken || !c.spaceKey) {
    throw new Error('CONFLUENCE_BASE_URL, CONFLUENCE_API_TOKEN and CONFLUENCE_SPACE_KEY must all be set (CI variables): the sync is off');
  }

  const started = Date.now();
  const timeoutMs = Math.min(config.get('playbook.syncTimeoutMs'), 60_000);
  const pages = await sync.readSpace(timeoutMs);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`read           ${pages.length} page(s) in ${secs} s`);
  for (const p of pages.slice(0, 5)) console.log(`               ${p.title}  (${p.url})`);
  if (pages.length > 5) console.log(`               … and ${pages.length - 5} more`);
  if (!pages.length) console.log('               the space is empty, or the account sees none of it');

  const at = process.argv.indexOf('--samples');
  if (at !== -1 && pages.length) {
    await samples(sync, pages, Math.max(1, Number(process.argv[at + 1]) || 3), timeoutMs);
  }
}

main().catch((err) => {
  const code: string | undefined = err?.code ?? err?.cause?.code;
  console.error(`FAILED: ${err?.message ?? err}${code ? ` [${code}]` : ''}`);
  if (code && HINTS[code]) console.error(`               ${HINTS[code]}`);
  process.exit(1);
});
