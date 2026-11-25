import type { HistoryEntry } from '../core/model/editor';

export interface QuickCaptureRequest {
  id: string;
  path: string;
  text: string;
}
export type QuickCaptureOwnerResult =
  | { kind: 'saved' | 'recovery' }
  | { kind: 'rejected'; message: string };

interface Receipt {
  before: string;
  after: string;
  entry: HistoryEntry;
}
type CaptureResult = { kind: 'saved' | 'recovery' } | { kind: 'closed'; receipt: Receipt };

export interface QuickCaptureDriver {
  recent(): Promise<string[]>;
  choose(): Promise<string | null>;
  save(path: string, id: string, text: string): Promise<CaptureResult>;
  close(): Promise<void>;
}
