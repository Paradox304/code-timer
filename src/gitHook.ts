import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

const MARKER = '# code-timer-hook';
const ELAPSED_FILENAME = 'code-timer-elapsed';

const PREPARE_HOOK = `#!/bin/sh
${MARKER}
# Appends elapsed-time line to commit messages.
case "$2" in
  merge|squash) exit 0 ;;
esac
git_dir="$(git rev-parse --git-dir 2>/dev/null)" || exit 0
elapsed_file="$git_dir/${ELAPSED_FILENAME}"
[ -f "$elapsed_file" ] || exit 0
line="$(cat "$elapsed_file")"
[ -n "$line" ] || exit 0
grep -qF -- "$line" "$1" 2>/dev/null && exit 0
printf '\\n\\n%s\\n' "$line" >> "$1"
`;

const POST_HOOK = `#!/bin/sh
${MARKER}
# Signals the Git Code Timer extension to reset after a commit.
git_dir="$(git rev-parse --git-dir 2>/dev/null)" || exit 0
: > "$git_dir/${ELAPSED_FILENAME}"
`;

function gitDir(): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? path.join(root, '.git') : undefined;
}

export function elapsedFilePath(): string | undefined {
  const dir = gitDir();
  return dir ? path.join(dir, ELAPSED_FILENAME) : undefined;
}

async function writeHook(hookPath: string, body: string): Promise<'installed' | 'exists-foreign' | 'noop'> {
  const existing = await fs.readFile(hookPath, 'utf8').catch(() => '');
  if (existing.includes(MARKER)) return 'noop';
  if (existing.trim()) return 'exists-foreign';
  await fs.writeFile(hookPath, body, { mode: 0o755 });
  return 'installed';
}

export async function installHooks(silent = false): Promise<void> {
  const dir = gitDir();
  if (!dir) return;
  const hooksDir = path.join(dir, 'hooks');
  try {
    await fs.mkdir(hooksDir, { recursive: true });
    const prep = await writeHook(path.join(hooksDir, 'prepare-commit-msg'), PREPARE_HOOK);
    const post = await writeHook(path.join(hooksDir, 'post-commit'), POST_HOOK);
    if (!silent) {
      const states = [prep, post];
      if (states.includes('exists-foreign')) {
        vscode.window.showWarningMessage(
          'Git Code Timer: a foreign git hook already exists. Skipping install — integrate manually or remove the existing hook.'
        );
      } else if (states.every(s => s === 'noop')) {
        vscode.window.showInformationMessage('Git Code Timer: git hooks already installed.');
      } else {
        vscode.window.showInformationMessage('Git Code Timer: git hooks installed.');
      }
    }
  } catch (e) {
    if (!silent) vscode.window.showErrorMessage(`Git Code Timer: hook install failed — ${e}`);
  }
}

export async function uninstallHooks(): Promise<void> {
  const dir = gitDir();
  if (!dir) return;
  for (const name of ['prepare-commit-msg', 'post-commit']) {
    const p = path.join(dir, 'hooks', name);
    const body = await fs.readFile(p, 'utf8').catch(() => '');
    if (body.includes(MARKER)) await fs.unlink(p).catch(() => {});
  }
  const ef = elapsedFilePath();
  if (ef) await fs.unlink(ef).catch(() => {});
  vscode.window.showInformationMessage('Git Code Timer: git hooks removed.');
}

export async function writeElapsed(text: string): Promise<void> {
  const p = elapsedFilePath();
  if (!p) return;
  await fs.writeFile(p, text).catch(() => {});
}

// Returns true when the elapsed file has been emptied externally
// (post-commit hook truncates it after a commit).
export async function elapsedWasCleared(): Promise<boolean> {
  const p = elapsedFilePath();
  if (!p) return false;
  const body = await fs.readFile(p, 'utf8').catch(() => null);
  return body === '';
}
