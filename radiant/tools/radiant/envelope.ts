import { suggest } from '../../src/lib/core/io/map-spec';

/** Version of the JSON envelope and of every report shape inside it. */
export const SCHEMA_VERSION = 1;
export const TOOL_VERSION = '0.2.0';

/** Exit codes (implementation spec 8.1). */
export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  notFound: 3,
  invalid: 4,
  conflict: 5,
  denied: 6,
  unavailable: 7
} as const;

export const EXIT_MEANINGS: Record<number, string> = {
  0: 'Success, including lint with issues',
  1: 'Unexpected internal failure',
  2: 'Usage error: unknown command or flag',
  3: 'Not found: file, node, link, theme',
  4: 'Invalid input: spec, ops or document failed validation',
  5: 'Conflict: revision mismatch, file exists, file open in the app',
  6: 'Not permitted: no grant, or tier too low',
  7: 'App unavailable or timed out; safe to retry after a read'
};

/** Characters of command output printed to stdout before a result is cut, unless --all or --max-chars is given. */
export const OUTPUT_BUDGET = 40_000;

export interface ErrorExtra {
  suggestions?: string[];
  hint?: string;
  /** Extra structured fields, for example diagnostics. */
  details?: Record<string, unknown>;
}

/** A failure caused by input or environment, reported as a structured error with an exit code. */
export class CliError extends Error {
  readonly suggestions: string[];
  readonly hint?: string;
  readonly details?: Record<string, unknown>;
  constructor(readonly code: string, readonly exit: number, message: string, extra: ErrorExtra = {}) {
    super(message);
    this.suggestions = extra.suggestions ?? [];
    this.hint = extra.hint;
    this.details = extra.details;
  }
}

export const usageError = (message: string, extra?: ErrorExtra) => new CliError('usage', EXIT.usage, message, extra);
export const notFound = (code: string, message: string, extra?: ErrorExtra) => new CliError(code, EXIT.notFound, message, extra);
export const invalid = (code: string, message: string, extra?: ErrorExtra) => new CliError(code, EXIT.invalid, message, extra);
export const conflict = (code: string, message: string, extra?: ErrorExtra) => new CliError(code, EXIT.conflict, message, extra);
export const denied = (code: string, message: string, extra?: ErrorExtra) => new CliError(code, EXIT.denied, message, extra);
export const unavailable = (code: string, message: string, extra?: ErrorExtra) => new CliError(code, EXIT.unavailable, message, extra);

/** What a command returns: a typed JSON payload, and the text printed without --json. */
export interface CommandResult {
  type: string;
  data: unknown;
  /** Text for stdout without --json. Default: data as indented JSON. */
  text?: string;
  /** Lines for stderr without --json (warnings, truncation notices). */
  notes?: string[];
  /** Exit code for a successful run that should still fail (lint --fail-on). */
  exit?: number;
}

export function envelope(result: CommandResult) {
  return { ok: true, schemaVersion: SCHEMA_VERSION, type: result.type, data: result.data };
}

export function errorEnvelope(error: CliError) {
  return {
    ok: false,
    schemaVersion: SCHEMA_VERSION,
    error: {
      code: error.code,
      exit: error.exit,
      message: error.message,
      suggestions: error.suggestions,
      ...(error.hint ? { hint: error.hint } : {}),
      ...(error.details ?? {})
    }
  };
}

/** Text form of an error for stderr. */
export function errorText(error: CliError): string {
  const lines = [error.message];
  const diagnostics = error.details?.diagnostics;
  if (Array.isArray(diagnostics)) for (const d of diagnostics as Record<string, unknown>[]) lines.push('  ' + diagnosticText(d));
  if (error.suggestions.length) lines.push('Did you mean: ' + error.suggestions.join(', ') + '?');
  if (error.hint) lines.push('Try: ' + error.hint);
  return lines.join('\n');
}

export function diagnosticText(d: Record<string, unknown>, file = ''): string {
  const where = d.line !== undefined ? (file ? file + ':' : 'line ') + String(d.line) + (d.column !== undefined ? ':' + String(d.column) : '') + ': '
    : d.path !== undefined ? String(d.path) + ': ' : '';
  const hints = Array.isArray(d.suggestions) && d.suggestions.length ? ' (did you mean ' + (d.suggestions as string[]).join(', ') + '?)' : '';
  return where + String(d.severity ?? 'note') + ': ' + String(d.message) + hints;
}

/** Suggestions for a mistyped name among candidates. */
export const nearest = (input: string, candidates: Iterable<string>, max = 3) => suggest(input, candidates, max);
