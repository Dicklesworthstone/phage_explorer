export interface CommandItem {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  action: () => void;
}

let commands: CommandItem[] = [];

export function setCommands(next: CommandItem[]): void {
  commands = next;
}

export function getCommands(): CommandItem[] {
  return commands;
}

