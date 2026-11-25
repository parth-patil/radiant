import { EXIT, CliError, nearest, usageError } from './envelope';

export type FlagType = 'boolean' | 'string' | 'number' | 'list';

export interface FlagSpec {
  name: string;
  type: FlagType;
  short?: string;
  description: string;
  values?: readonly string[];
}

export interface ArgSpec {
  name: string;
  required?: boolean;
  description: string;
  /** Collects the remaining positional arguments. */
  rest?: boolean;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | number | boolean | string[] | undefined>;
}

export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: 'json', type: 'boolean', description: 'Write exactly one JSON envelope to stdout.' },
  { name: 'help', type: 'boolean', short: 'h', description: 'Describe this command (with --json, as data).' }
];

/** Parse argv for one command. Unknown flags and extra arguments are usage errors with suggestions. */
export function parseArgs(argv: readonly string[], args: readonly ArgSpec[], flags: readonly FlagSpec[], command: string): ParsedArgs {
  const all = [...flags, ...GLOBAL_FLAGS];
  const byName = new Map(all.map((f) => [f.name, f]));
  const byShort = new Map(all.filter((f) => f.short).map((f) => [f.short!, f]));
  const out: ParsedArgs = { positionals: [], flags: {} };
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (literal || token === '-' || !token.startsWith('-') || /^-\d/.test(token)) {
      out.positionals.push(token);
      continue;
    }
    if (token === '--') { literal = true; continue; }
    let name: string;
    let value: string | undefined;
    let spec: FlagSpec | undefined;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      name = eq < 0 ? token.slice(2) : token.slice(2, eq);
      value = eq < 0 ? undefined : token.slice(eq + 1);
      spec = byName.get(name);
    } else {
      name = token.slice(1);
      spec = byShort.get(name);
    }
    if (!spec) {
      const names = all.map((f) => f.name);
      throw usageError('Unknown flag "' + token + '" for "' + command + '".', {
        suggestions: nearest(name, names).map((n) => '--' + n),
        hint: 'radiant ' + command + ' --help'
      });
    }
    if (spec.type === 'boolean') {
      if (value !== undefined && value !== 'true' && value !== 'false') throw usageError('Flag --' + spec.name + ' takes no value.');
      out.flags[spec.name] = value !== 'false';
      continue;
    }
    if (value === undefined) {
      if (i + 1 >= argv.length) throw usageError('Flag --' + spec.name + ' needs a value.', { hint: 'radiant ' + command + ' --help' });
      value = argv[++i];
    }
    if (spec.values && !spec.values.includes(value)) {
      throw usageError('Invalid value "' + value + '" for --' + spec.name + '. Values: ' + spec.values.join(', ') + '.', {
        suggestions: nearest(value, spec.values)
      });
    }
    if (spec.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw usageError('Flag --' + spec.name + ' needs a number, not "' + value + '".');
      out.flags[spec.name] = n;
    } else if (spec.type === 'list') {
      const list = (out.flags[spec.name] as string[] | undefined) ?? [];
      list.push(value);
      out.flags[spec.name] = list;
    } else out.flags[spec.name] = value;
  }
  if (out.flags.help) return out;
  const required = args.filter((a) => a.required).length;
  const rest = args.some((a) => a.rest);
  if (out.positionals.length < required) {
    const missing = args.filter((a) => a.required)[out.positionals.length];
    throw usageError('Missing ' + missing.name + ' for "' + command + '".', { hint: 'radiant ' + command + ' --help' });
  }
  if (!rest && out.positionals.length > args.length) {
    throw usageError('Too many arguments for "' + command + '": "' + out.positionals[args.length] + '".', { hint: 'radiant ' + command + ' --help' });
  }
  return out;
}

export const flagString = (p: ParsedArgs, name: string) => p.flags[name] as string | undefined;
export const flagNumber = (p: ParsedArgs, name: string) => p.flags[name] as number | undefined;
export const flagBool = (p: ParsedArgs, name: string) => p.flags[name] === true;
export const flagList = (p: ParsedArgs, name: string) => (p.flags[name] as string[] | undefined) ?? [];

export function positiveInt(p: ParsedArgs, name: string, fallback?: number, min = 0): number | undefined {
  const v = flagNumber(p, name);
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || v < min) throw new CliError('usage', EXIT.usage, '--' + name + ' must be a whole number of at least ' + min + '.');
  return v;
}
