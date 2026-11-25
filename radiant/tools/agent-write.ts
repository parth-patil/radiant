import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentEdit } from '../src/lib/host/agent';

const byteLength = (value: string) => Buffer.byteLength(value, 'utf8');
const protocolId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/i);
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const text = z.string().refine((value) => !!value.trim() && byteLength(value) <= 1_000 && !controls.test(value));
const note = z.string().refine((value) => byteLength(value) <= 8_000 && !controls.test(value));
const edit = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('add'), parent: protocolId, text }),
  z.strictObject({ type: z.literal('rename'), id: protocolId, text }),
  z.strictObject({ type: z.literal('set-note'), id: protocolId, note })
]);
export const agentEdits = z.array(edit).min(1).max(32);

const MAX_FRAME = 64 * 1024;
/** Frame limit for op batches (the host's limit; the three-edit message keeps 64 KiB). */
export const MAX_OPS_FRAME = 8 * 1024 * 1024;

export interface AgentConnection {
  socket: string;
  documentId: string;
  token: string;
  path: string;
}

export function writeConnection(): AgentConnection {
  const { RADIANT_AGENT_SOCKET: socket, RADIANT_AGENT_DOCUMENT: documentId,
    RADIANT_AGENT_TOKEN: token, RADIANT_AGENT_PATH: path } = process.env;
  if (!socket || !socket.startsWith('/') || !path?.startsWith('/') || !token || !documentId ||
    !/^[0-9a-f]{32}$/.test(token) || !protocolId.safeParse(documentId).success) {
    throw new Error('Set the active map’s connection details from Radiant’s Local agent access panel.');
  }
  return { socket, token, documentId, path };
}

export async function readEdits(): Promise<AgentEdit[]> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size >= MAX_FRAME) throw new Error('Edit input exceeds 64 KiB.');
    chunks.push(bytes);
  }
  return agentEdits.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

export function optionalConnection(): AgentConnection | null {
  const keys = ['RADIANT_AGENT_SOCKET', 'RADIANT_AGENT_DOCUMENT', 'RADIANT_AGENT_TOKEN', 'RADIANT_AGENT_PATH'];
  return keys.some(key => process.env[key] !== undefined) ? writeConnection() : null;
}

const editReply = z.strictObject({ ok: z.literal(true) });
const readReply = z.strictObject({ ok: z.literal(true), snapshot: z.string(), writable: z.boolean(), destructive: z.boolean().optional(), revision: z.string().optional() });
const resultReply = z.strictObject({ ok: z.literal(true), result: z.unknown() });
const denied = z.strictObject({ ok: z.literal(false), error: z.string() });

export async function requestEdits(connection: AgentConnection, edits: AgentEdit[]): Promise<void> {
  await request(connection, { edits: agentEdits.parse(edits) }, editReply, 8_192);
}

export async function requestSnapshot(connection: AgentConnection): Promise<{ snapshot: string; writable: boolean; destructive?: boolean; revision?: string }> {
  // The native limit is 16 MiB for the snapshot. JSON quoting can double the response.
  return request(connection, { read: true }, readReply, 33 * 1024 * 1024);
}

/**
 * Send an agent op batch (validated locally with core/model/agent-ops.ts first). destructive declares that the
 * batch deletes; the host refuses it without the destructive grant. The result is the app's reply or error object.
 */
export async function requestOps(connection: AgentConnection, batch: unknown, destructive: boolean): Promise<unknown> {
  return (await request(connection, { ops: batch, destructive }, resultReply, 2 * 1024 * 1024, MAX_OPS_FRAME)).result;
}

/** Undo the named agent transaction in the app, if it is the latest change. */
export async function requestUndo(connection: AgentConnection, tx: string): Promise<unknown> {
  return (await request(connection, { undo: tx }, resultReply, 64 * 1024)).result;
}

/** Change the selection or the camera of the granted map, or report them. Allowed on a read grant. */
export async function requestView(connection: AgentConnection, command: object): Promise<unknown> {
  return (await request(connection, { view: command }, resultReply, 2 * 1024 * 1024)).result;
}

// ---------------------------------------------------------------- asking the app for access

/** A grant the app issued after the user allowed a request. It stays in memory: never written to a file. */
export interface LiveGrant extends AgentConnection {
  title: string;
  writable: boolean;
  destructive: boolean;
  idleMs: number;
}

/** The app's control socket, in its data folder (override with RADIANT_AGENT_CONTROL). */
export function controlSocketPath(): string {
  if (process.env.RADIANT_AGENT_CONTROL) return process.env.RADIANT_AGENT_CONTROL;
  const data = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(data, 'app.radiant.mindmap', 'agent', 'control.sock');
}

const statusReply = z.object({ ok: z.literal(true), app: z.string(), version: z.string(), protocol: z.number() });
const grantReply = z.object({ ok: z.literal(true), grant: z.object({
  socket: z.string().startsWith('/'), token: z.string().regex(/^[0-9a-f]{32}$/), documentId: protocolId, path: z.string().min(1),
  writable: z.boolean(), destructive: z.boolean(), idleMs: z.number(), title: z.string()
}) });

/** One JSON line to the control socket, one line back. Rejects with the app's message when it declines. */
function control<T>(payload: object, success: z.ZodType<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const caller = createConnection({ path: controlSocketPath() }, () => caller.write(JSON.stringify(payload) + '\n'));
    const deadline = setTimeout(() => fail('Radiant did not answer before the request expired.'), timeoutMs);
    function fail(message: string) {
      clearTimeout(deadline);
      caller.destroy();
      reject(new Error(message));
    }
    caller.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) return fail('The local app response exceeded its limit.');
      chunks.push(chunk);
      if (chunk.indexOf(10) < 0) return;
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
        const error = denied.safeParse(value);
        if (error.success) return fail(error.data.error);
        const reply = success.parse(value);
        clearTimeout(deadline);
        caller.destroy();
        resolve(reply);
      } catch {
        fail('Invalid local app response.');
      }
    });
    caller.on('error', () => fail('Radiant is not running, or this version does not answer agent requests.'));
    caller.on('end', () => fail('Radiant closed the connection before answering.'));
  });
}

/** Whether the app is running and answers agent requests. Never prompts. */
export async function requestStatus(): Promise<{ app: string; version: string; protocol: number } | null> {
  try { return await control({ status: true }, statusReply, 3_000); } catch { return null; }
}

/**
 * Ask the app for access to the map in its front window. The app shows a prompt naming the client; this resolves
 * with the grant when the user allows it, and rejects when they decline or do not answer within a minute.
 */
export async function requestConnect(client: string, access: 'read' | 'write' | 'destructive'): Promise<LiveGrant> {
  return (await control({ connect: { client, access } }, grantReply, 70_000)).grant;
}

async function request<T>(connection: AgentConnection, payload: object, success: z.ZodType<T>, responseLimit: number, frameLimit = MAX_FRAME): Promise<T> {
  // Only the three authorising fields go on the wire: the app rejects unknown fields, and a live grant carries more.
  const { socket, token, documentId, path } = connection;
  const frame = JSON.stringify({ token, documentId, path, ...payload }) + '\n';
  if (byteLength(frame) > frameLimit) throw new Error('Encoded request exceeds ' + Math.round(frameLimit / 1024) + ' KiB.');
  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const caller = createConnection({ path: socket }, () => caller.write(frame));
    const deadline = setTimeout(() => fail('The local app did not answer before the request expired.'), 16_000);
    function fail(message: string) {
      clearTimeout(deadline);
      caller.destroy();
      reject(new Error(message));
    }
    caller.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > responseLimit) return fail('The local app response exceeded its limit.');
      chunks.push(chunk);
      const newline = chunk.indexOf(10);
      if (newline < 0) return;
      if (newline !== chunk.length - 1) return fail('Invalid local app response.');
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
        const error = denied.safeParse(value);
        if (error.success) return fail(error.data.error);
        const reply = success.parse(value);
        clearTimeout(deadline);
        caller.destroy();
        resolve(reply);
      } catch {
        fail('Invalid local app response.');
      }
    });
    caller.on('error', () => fail('Could not reach the active local grant.'));
    caller.on('end', () => fail('The local connection closed before acknowledging the request.'));
  });
}
