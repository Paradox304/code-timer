import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

const DEFAULT_FILENAME = '.code-timer.json';

export interface TimerState {
  total: number;    // lifetime seconds tracked on this repo
  current: number;  // seconds since last reset / commit
}

// Resolves the state-file path for a single workspace folder. The `stateFile`
// setting is read per-folder so a multi-root workspace can override it per
// repository if desired.
export function stateFilePath(root: string): string {
  const rel = vscode.workspace
    .getConfiguration('gitCodeTimer', vscode.Uri.file(root))
    .get<string>('stateFile', DEFAULT_FILENAME)
    .trim() || DEFAULT_FILENAME;
  // Relative to the folder root; absolute paths are accepted as-is.
  return path.isAbsolute(rel) ? rel : path.join(root, rel);
}

export async function readState(root: string): Promise<TimerState | undefined> {
  const p = stateFilePath(root);
  const body = await fs.readFile(p, 'utf8').catch(() => undefined);
  if (body === undefined) return undefined;
  try {
    const parsed = JSON.parse(body) as Partial<TimerState>;
    const total = Number.isFinite(parsed.total) ? Math.max(0, parsed.total as number) : 0;
    const current = Number.isFinite(parsed.current) ? Math.max(0, parsed.current as number) : 0;
    return { total, current };
  } catch {
    return undefined;
  }
}

export async function writeState(root: string, state: TimerState): Promise<void> {
  const p = stateFilePath(root);
  const body = JSON.stringify({
    total: Math.round(state.total),
    current: Math.round(state.current),
  }) + '\n';
  await fs.mkdir(path.dirname(p), { recursive: true }).catch(() => {});
  await fs.writeFile(p, body).catch(() => {});
}
