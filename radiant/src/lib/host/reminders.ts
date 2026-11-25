export type ReminderScope = { path: string; documentId: string };
export type ReminderCompletion = { node: string; done: boolean };
export type ReminderResult = { Ok: ReminderCompletion } | { Err: string };

export interface ReminderHost {
  links(map: ReminderScope): Promise<string[]>;
  connect(map: ReminderScope, node: string, title: string, done: boolean): Promise<void>;
  disconnect(map: ReminderScope, node: string): Promise<void>;
  acknowledge(map: ReminderScope, tasks: ReminderCompletion[]): Promise<void>;
  sync(map: ReminderScope, tasks: ReminderCompletion[]): Promise<ReminderResult[]>;
}
