export type Tone = "neutral" | "success" | "warning" | "danger" | "accent";

export interface ConsoleRow {
  id: string;
  label: string;
  value: string;
  detail?: string;
  tone?: Tone;
  secret?: boolean;
}

export interface ConsoleField {
  key: string;
  label: string;
  value?: string;
  secret?: boolean;
  optional?: boolean;
}

export interface ConsoleAction {
  id: string;
  label: string;
  key?: string;
  fields?: ConsoleField[];
  fieldsByTarget?: Record<string, ConsoleField[]>;
  confirm?: string;
  tone?: Tone;
  disabled?: boolean;
  target?: boolean;
}

export interface ConsoleView {
  id: string;
  label: string;
  caption: string;
  rows: ConsoleRow[];
  actions: ConsoleAction[];
  empty?: string;
}

export interface ConsoleLog {
  time: number;
  text: string;
  tone?: Tone;
}

export interface ConsoleData {
  name: string;
  subtitle: string;
  status: string;
  tone: Tone;
  endpoint: string;
  ownedRunning: boolean;
  views: ConsoleView[];
  logs: ConsoleLog[];
}

export interface ConsoleAdapter {
  read(): Promise<ConsoleData>;
  execute(
    action: string,
    values: Record<string, string>,
    target?: string,
  ): Promise<string>;
  dispose(): Promise<void>;
}
