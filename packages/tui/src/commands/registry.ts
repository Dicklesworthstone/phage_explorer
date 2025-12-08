export interface CommandItem {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  category?: string;
  shortcut?: string;
  minLevel?: 'novice' | 'intermediate' | 'power';
  action: () => void;
}

let commands: CommandItem[] = [];

export function setCommands(next: CommandItem[]): void {
  // Store a shallow copy to avoid external mutations
  commands = [...next];
}

export function getCommands(): CommandItem[] {
  // Return a copy to avoid accidental external mutation
  return [...commands];
}
