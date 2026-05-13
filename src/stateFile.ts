import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

const DEFAULT_FILENAME = '.code-timer.json';

export interface TimerState {
  total: number;    // lifetime seconds tracked on this repo
  current: number;  // seconds since last reset / commit
}

export function stateFilePath(): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return undefined;
  const rel = vscode.workspace
    .getConfiguration('codeTimer')
    .get<string>('stateFile', DEFAULT_FILENAME)
    .trim() || DEFAULT_FILENAME;
  // Relative to workspace root; absolute paths are accepted as-is.
  return path.isAbsolute(rel) ? rel : path.join(root, rel);
}

export async function readState(): Promise<TimerState | undefined> {
  const p = stateFilePath();
  if (!p) return undefined;
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

export async function writeState(state: TimerState): Promise<void> {
  const p = stateFilePath();
  if (!p) return;
  const body = JSON.stringify({
    total: Math.round(state.total),
    current: Math.round(state.current),
  }) + '\n';
  await fs.mkdir(path.dirname(p), { recursive: true }).catch(() => {});
  await fs.writeFile(p, body).catch(() => {});
}
