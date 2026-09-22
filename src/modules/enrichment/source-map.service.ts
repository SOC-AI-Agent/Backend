import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface SourceHint {
  /** Set when nothing identified the source. The agent is told to find out
   *  rather than assume, and the fields are kept so the tail becomes visible. */
  unknown?: boolean;
  /** The distinctive fields this alert carried, when it could not be placed.
   *  Reviewing these is how a rule gets written for a family worth having one. */
  signature?: string[];
  /** Splunk ES security domain: network, endpoint, access, threat, audit, identity. */
  domain?: string;
  /** The sourcetype the notable was raised from, when it says. */
  sourcetype?: string;
  /** A CIM data model, which beats a sourcetype: its field names are standard. */
  dataModel?: string;
  index?: string;
  /** Which field answered, so a wrong hint leads back to its cause. */
  from: string;
}

/**
 * Where an alert's own data lives, read from the alert rather than guessed.
 *
 * A Splunk ES notable already carries this. `orig_security_domain` is ES's own
 * taxonomy — network, endpoint, access, threat, audit — and is the same split a
 * SOC organises its analysts by. `orig_sourcetype` names the sourcetype exactly.
 * `data_model` is better still: a CIM model means the field names are already
 * standard, so the mapping problem does not arise for that data at all.
 *
 * Reading those beats matching patterns against the log text, which is a guess
 * about a string the vendor is free to change. Patterns stay as a fallback for
 * alerts that carry none of it — a raw syslog line forwarded by a SOAR, say.
 *
 * It narrows the first search. It does not decide the investigation: a network
 * alert may still need endpoint data, and the agent is free to ask.
 */
@Injectable()
export class SourceMapService {
  private readonly logger = new Logger(SourceMapService.name);

  // ES ships these; an estate may add its own.
  private static readonly ES_DOMAINS = [
    'access', 'endpoint', 'network', 'threat', 'identity', 'audit', 'cloud',
  ];

  /**
   * Log families identified by the fields they carry, for alerts that arrive
   * raw rather than as ES notables — a CloudTrail record forwarded straight
   * through has no search_name and no security domain, but no other log has
   * eventSource next to awsRegion.
   *
   * A set of field names is a far better signature than a substring of the
   * text: it does not break when a vendor renames a value, and it cannot match
   * by accident on a hostname that happens to contain the word.
   *
   * Extend through ALERT_SOURCE_SIGNATURES rather than editing this.
   */
  private static readonly SIGNATURES: Array<{
    requires: string[]; domain: string; sourcetype?: string; family: string;
  }> = [
    { requires: ['eventsource', 'awsregion', 'eventversion'],
      domain: 'cloud', sourcetype: 'aws:cloudtrail', family: 'AWS CloudTrail' },
    { requires: ['operationname', 'tenantid', 'resourceid'],
      domain: 'cloud', sourcetype: 'azure:activity', family: 'Azure Activity' },
    { requires: ['protopayload_auditlog', 'resource.type'],
      domain: 'cloud', sourcetype: 'google:gcp:pubsub:message', family: 'GCP audit' },
    { requires: ['winlog.event_id', 'winlog.channel'],
      domain: 'endpoint', sourcetype: 'XmlWinEventLog', family: 'Windows event log' },
  ];

  // Present in almost every log, so useless for telling one family from
  // another — excluded from a recorded signature to keep it readable.
  private static readonly COMMON_FIELDS = new Set([
    'host', 'source', 'sourcetype', 'index', '_time', '_raw', 'time', 'timestamp',
    'severity', 'type', 'action', 'user', 'count', 'src', 'dest', 'message',
  ]);

  constructor(private readonly config: ConfigService) {}

  private get rules(): Array<{ pattern: string; index: string; sourcetype?: string }> {
    const raw = this.config.get<string>('enrichment.sourceMap') ?? '';
    return raw
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)
      .map((entry) => {
        const [pattern, target] = entry.split('=');
        const [index, sourcetype] = (target ?? '').split(':');
        return { pattern: (pattern ?? '').toLowerCase(), index, sourcetype };
      })
      .filter((r) => r.pattern && r.index);
  }

  /**
   * `supplied` is the alert as the SOAR sent it, when it sent structured fields.
   * Falls back to reading the same names out of the raw text, because a SOAR
   * that renders its record to a string still renders these.
   */
  /**
   * Signatures from the environment, tried before the built-in ones:
   *   ALERT_SOURCE_SIGNATURES=eventSource+awsRegion=cloud:aws:cloudtrail
   */
  private get signatures(): Array<{
    requires: string[]; domain: string; sourcetype?: string; family: string;
  }> {
    const raw = this.config.get<string>('enrichment.sourceSignatures') ?? '';
    return raw
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)
      .map((entry) => {
        const [fields, target] = entry.split('=');
        const [domain, ...rest] = (target ?? '').split(':');
        return {
          requires: (fields ?? '').split('+').map((f) => f.trim().toLowerCase()).filter(Boolean),
          domain,
          sourcetype: rest.join(':') || undefined,
          family: 'configured',
        };
      })
      .filter((s) => s.requires.length > 0 && s.domain);
  }

  resolve(alertName: string, rawLog: string, supplied?: Record<string, unknown>): SourceHint | null {
    const field = (name: string): string | undefined => {
      const direct = supplied?.[name];
      if (typeof direct === 'string' && direct.trim()) return direct.trim();
      // key="value" or key=value in the rendered text
      const match = rawLog.match(new RegExp(`\\b${name}\\s*=\\s*"?([^"\\s,;]+)`, 'i'));
      return match?.[1];
    };

    const hint: SourceHint = { from: '' };
    const found: string[] = [];

    const dataModel = field('data_model');
    if (dataModel) {
      hint.dataModel = dataModel;
      found.push('data_model');
    }

    const sourcetype = field('orig_sourcetype') ?? field('sourcetype');
    if (sourcetype) {
      hint.sourcetype = sourcetype;
      found.push('orig_sourcetype');
    }

    const index = field('orig_index') ?? field('index');
    if (index) {
      hint.index = index;
      found.push('orig_index');
    }

    const domain = (field('orig_security_domain') ?? '').toLowerCase();
    if (SourceMapService.ES_DOMAINS.includes(domain)) {
      hint.domain = domain;
      found.push('orig_security_domain');
    } else {
      // ES correlation searches are named "<Domain> - <rule> - Rule", so the
      // prefix carries the same answer when the field is absent.
      const prefix = alertName.split(' - ')[0]?.trim().toLowerCase();
      if (prefix && SourceMapService.ES_DOMAINS.includes(prefix)) {
        hint.domain = prefix;
        found.push('search_name prefix');
      }
    }

    if (found.length > 0) {
      hint.from = found.join(', ');
      return hint;
    }

    // No ES fields. Identify the log family by which fields are present.
    const present = new Set(
      [
        ...Object.keys(supplied ?? {}),
        ...[...rawLog.matchAll(/\b([A-Za-z][\w.]{2,40})\s*=/g)].map((m) => m[1]),
      ].map((k) => k.toLowerCase()),
    );

    for (const sig of [...this.signatures, ...SourceMapService.SIGNATURES]) {
      if (sig.requires.every((f) => present.has(f))) {
        return {
          domain: sig.domain,
          sourcetype: sig.sourcetype,
          from: `field signature (${sig.family}: ${sig.requires.join(' + ')})`,
        };
      }
    }

    // Nothing structured. Fall back to matching the configured patterns.
    const haystack = `${alertName}\n${rawLog}`.toLowerCase();
    for (const rule of this.rules) {
      if (haystack.includes(rule.pattern)) {
        return {
          index: rule.index,
          sourcetype: rule.sourcetype,
          from: `ALERT_SOURCE_MAP rule "${rule.pattern}"`,
        };
      }
    }
    // Nothing placed it. That is the normal case for the long tail of log
    // families, and no list of signatures will ever cover them all — so the
    // answer is not a better guess, it is saying so and recording what arrived.
    const distinctive = [...present]
      .filter((f) => !SourceMapService.COMMON_FIELDS.has(f))
      .sort()
      .slice(0, 12);

    this.logger.warn(
      `could not place alert "${alertName.slice(0, 60)}" — fields: ${distinctive.join(', ')}`,
    );
    return { unknown: true, signature: distinctive, from: 'nothing matched' };
  }

  /** How the hint reads to the model. */
  render(hint: SourceHint | null): string {
    const lines = ['--- WHERE THIS ALERT CAME FROM ---'];

    if (!hint || hint.unknown) {
      lines.push(
        'Unknown. This alert carries no index, sourcetype or security domain,',
        'and no rule recognised it.',
        '',
        'Do not assume an index. Find out instead: take a distinctive value from',
        'the alert — an account, a hostname, a request id, an address — and search',
        'for it across the indexes you are allowed. Splunk will tell you where that',
        'value lives, and that is the index this alert came from.',
      );
      if (hint?.signature?.length) {
        lines.push('', `Distinctive fields in this alert: ${hint.signature.join(', ')}.`);
      }
      return lines.join('\n');
    }

    if (hint.dataModel) {
      // Worth calling out: a data model means CIM field names, so the usual
      // per-sourcetype naming problem does not apply to this data.
      lines.push(
        `Raised from the CIM data model \`${hint.dataModel}\`, so this data uses`,
        'standard CIM field names (src, dest, user) rather than vendor ones.',
      );
    }
    if (hint.sourcetype) lines.push(`Source sourcetype: \`${hint.sourcetype}\`.`);
    if (hint.index) lines.push(`Index: \`${hint.index}\`.`);
    if (hint.domain) {
      lines.push(`Security domain: ${hint.domain}. Search that data first.`);
    }

    lines.push(
      `(read from ${hint.from})`,
      'Other data lives elsewhere — ask for it by name if the alert needs it.',
    );
    return lines.join('\n');
  }
}
