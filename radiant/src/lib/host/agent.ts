export type AgentEdit =
  | { type: 'add'; parent: string; text: string }
  | { type: 'rename'; id: string; text: string }
  | { type: 'set-note'; id: string; note: string };

export interface AgentGrant {
  id: string;
  socket: string;
  token: string;
  expiresAt: number;
  /** The grant ends this long after its last request. */
  idleMs?: number;
  path: string;
}

/** An agent asking for access through the app's control socket; the window answers with a prompt. */
export interface AgentConsentRequest {
  id: string;
  /** The name the agent gave for itself. It is a claim, not an identity. */
  client: string;
  access: 'read' | 'write' | 'destructive';
}

/**
 * Work delivered by the native host. The host has checked the token, document, path, tier, frame size and rate;
 * an op batch is still unvalidated JSON, checked here with core/model/agent-ops.ts.
 */
export type AgentWork = { id: string; documentId: string } & (
  | { kind: 'read' }
  | { kind: 'edit'; edits: AgentEdit[] }
  | { kind: 'ops'; batch: unknown; destructive: boolean }
  | { kind: 'undo'; tx: string }
  /** Selection and camera only; allowed on a read grant. */
  | { kind: 'view'; command: unknown }
);

export interface AgentTransport {
  /** destructive: also allow deletes (the destructive tier, off by default). */
  grant(documentId: string, path: string, writable: boolean, destructive?: boolean): Promise<AgentGrant>;
  revoke(id: string): Promise<void>;
  take(id: string): Promise<AgentWork | null>;
  /** snapshot carries the document for a read, or the JSON reply for ops and undo. */
  finish(grantId: string, requestId: string, error?: string, snapshot?: string, revision?: string): Promise<void>;
  /** Hear access requests for this window, and their withdrawal (the request expired or was answered). */
  onConsent?(ask: (request: AgentConsentRequest) => void, withdraw: (id: string) => void): Promise<() => void>;
  /** Answer an access request: the id of the grant issued for it, or null to decline. */
  consent?(id: string, grantId: string | null, title?: string): Promise<void>;
}

type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
type Listen = <T>(event: string, handler: (payload: T) => void) => Promise<() => void>;

export function createAgentTransport(invoke: Invoke, listen?: Listen): AgentTransport {
  return {
    ...(listen ? {
      onConsent: async (ask, withdraw) => {
        const stops = await Promise.all([listen<AgentConsentRequest>('agent-consent', ask), listen<string>('agent-consent-cancel', withdraw)]);
        return () => stops.forEach((stop) => stop());
      },
      consent: (id, grantId, title) => invoke('agent_consent', { id, grantId, title: title ?? null })
    } : {}),
    grant: (documentId, path, writable, destructive) => invoke('agent_grant', { documentId, path, writable, destructive: destructive ?? false }),
    revoke: (id) => invoke('agent_revoke', { id }),
    take: (id) => invoke('agent_take', { id }),
    finish: (grantId, requestId, error, snapshot, revision) =>
      invoke('agent_finish', { grantId, requestId, error: error ?? null, snapshot: snapshot ?? null, revision: revision ?? null })
  };
}
