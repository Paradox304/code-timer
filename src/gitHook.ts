import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { log } from './log';

const MARKER = '# code-timer-hook';
const ELAPSED_FILENAME = 'code-timer-elapsed';
const DEBUG_FILENAME = 'code-timer-debug.log';
const FOREIGN_SUFFIX = '.foreign';

// Both hook bodies are "chain-aware": after running our logic they `exec`
// any displaced foreign hook saved at <hookname>.foreign. This lets two
// extensions share the same hook slot when the user picks "Chain".
const PREPARE_HOOK = `#!/bin/sh
${MARKER}
# Appends elapsed-time line to commit messages; chains to a displaced
# foreign hook if one exists at prepare-commit-msg.foreign.
git_dir="$(git rev-parse --git-dir 2>/dev/null)"
log="$git_dir/${DEBUG_FILENAME}"
printf '[%s] prepare-commit-msg fired: msg_file=%s source=%s sha=%s\\n' "$(date -Iseconds)" "$1" "$2" "$3" >> "$log"
case "$2" in
  merge|squash)
    printf '[%s]   skip ours (source=%s)\\n' "$(date -Iseconds)" "$2" >> "$log"
    ;;
  *)
    if [ -n "$git_dir" ]; then
      elapsed_file="$git_dir/${ELAPSED_FILENAME}"
      if [ ! -f "$elapsed_file" ]; then
        printf '[%s]   no elapsed file at %s\\n' "$(date -Iseconds)" "$elapsed_file" >> "$log"
      else
        line="$(cat "$elapsed_file")"
        if [ -z "$line" ]; then
          printf '[%s]   elapsed file empty\\n' "$(date -Iseconds)" >> "$log"
        elif grep -qF -- "$line" "$1" 2>/dev/null; then
          printf '[%s]   line already present in commit msg, skipping\\n' "$(date -Iseconds)" >> "$log"
        else
          printf '\\n\\n%s\\n' "$line" >> "$1"
          printf '[%s]   appended: %s\\n' "$(date -Iseconds)" "$line" >> "$log"
        fi
      fi
    fi
    ;;
esac
foreign="$(dirname "$0")/$(basename "$0")${FOREIGN_SUFFIX}"
if [ -x "$foreign" ]; then
  printf '[%s]   chaining to foreign hook: %s\\n' "$(date -Iseconds)" "$foreign" >> "$log"
  exec "$foreign" "$@"
fi
exit 0
`;

const POST_HOOK = `#!/bin/sh
${MARKER}
# Signals the Git Code Timer extension to reset after a commit; chains to
# any displaced foreign hook saved at post-commit.foreign.
git_dir="$(git rev-parse --git-dir 2>/dev/null)"
log="$git_dir/${DEBUG_FILENAME}"
printf '[%s] post-commit fired, clearing elapsed file\\n' "$(date -Iseconds)" >> "$log"
[ -n "$git_dir" ] && : > "$git_dir/${ELAPSED_FILENAME}"
foreign="$(dirname "$0")/$(basename "$0")${FOREIGN_SUFFIX}"
if [ -x "$foreign" ]; then
  printf '[%s]   chaining to foreign hook: %s\\n' "$(date -Iseconds)" "$foreign" >> "$log"
  exec "$foreign" "$@"
fi
exit 0
`;

function gitDir(): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? path.join(root, '.git') : undefined;
}

export function elapsedFilePath(): string | undefined {
  const dir = gitDir();
  return dir ? path.join(dir, ELAPSED_FILENAME) : undefined;
}

type WriteResult =
  | { result: 'installed' | 'updated' | 'noop' }
  | { result: 'foreign'; foreignBody: string };

async function writeHook(hookPath: string, body: string): Promise<WriteResult> {
  const existing = await fs.readFile(hookPath, 'utf8').catch(() => '');
  if (existing.includes(MARKER)) {
    if (existing === body) {
      log(`hook up-to-date: ${hookPath}`);
      return { result: 'noop' };
    }
    await fs.writeFile(hookPath, body, { mode: 0o755 });
    log(`hook updated: ${hookPath}`);
    return { result: 'updated' };
  }
  if (existing.trim()) {
    log(`hook exists (foreign), needs resolution: ${hookPath}`);
    return { result: 'foreign', foreignBody: existing };
  }
  await fs.writeFile(hookPath, body, { mode: 0o755 });
  log(`hook installed: ${hookPath}`);
  return { result: 'installed' };
}

type ForeignChoice = 'replace' | 'chain' | 'skip';

// Asks the user how to handle a foreign hook we'd otherwise overwrite.
// Memoized for the lifetime of the VSCode window so a single "Chain" answer
// covers both prepare and post hooks without a second prompt.
let rememberedChoice: ForeignChoice | undefined;

async function resolveForeignHook(hookPath: string): Promise<ForeignChoice> {
  if (rememberedChoice) return rememberedChoice;
  const name = path.basename(hookPath);
  const choice = await vscode.window.showWarningMessage(
    `Git Code Timer: another tool already owns ${name}. How should we proceed?`,
    { modal: false },
    'Replace',
    'Chain (run both)',
    'Skip',
  );
  if (choice === 'Replace') rememberedChoice = 'replace';
  else if (choice === 'Chain (run both)') rememberedChoice = 'chain';
  else rememberedChoice = 'skip';
  log(`foreign-hook resolution for ${name}: ${rememberedChoice}`);
  return rememberedChoice;
}

async function applyForeignChoice(
  hookPath: string,
  body: string,
  foreignBody: string,
  choice: ForeignChoice,
): Promise<void> {
  if (choice === 'skip') return;
  if (choice === 'replace') {
    await fs.writeFile(hookPath, body, { mode: 0o755 });
    log(`hook replaced (foreign discarded): ${hookPath}`);
    return;
  }
  // chain: save foreign aside, install ours on top
  const foreignPath = hookPath + FOREIGN_SUFFIX;
  await fs.writeFile(foreignPath, foreignBody, { mode: 0o755 });
  await fs.writeFile(hookPath, body, { mode: 0o755 });
  log(`hook chained: ours at ${hookPath}, foreign saved at ${foreignPath}`);
}

export async function installHooks(silent = false): Promise<void> {
  const dir = gitDir();
  if (!dir) {
    log('installHooks: no .git dir (no workspace folder?)');
    return;
  }
  const hooksDir = path.join(dir, 'hooks');
  log(`installHooks: target=${hooksDir} silent=${silent}`);
  rememberedChoice = undefined;
  try {
    await fs.mkdir(hooksDir, { recursive: true });
    const targets: [string, string][] = [
      [path.join(hooksDir, 'prepare-commit-msg'), PREPARE_HOOK],
      [path.join(hooksDir, 'post-commit'), POST_HOOK],
    ];

    const states: string[] = [];
    for (const [hookPath, body] of targets) {
      const w = await writeHook(hookPath, body);
      if (w.result === 'foreign') {
        const choice = await resolveForeignHook(hookPath);
        await applyForeignChoice(hookPath, body, w.foreignBody, choice);
        states.push(choice === 'skip' ? 'foreign-skipped' : choice);
      } else {
        states.push(w.result);
      }
    }

    if (!silent) {
      if (states.includes('foreign-skipped')) {
        vscode.window.showWarningMessage(
          'Git Code Timer: one or more hooks were skipped. Re-run "Install Git Hooks" if you change your mind.',
        );
      } else if (states.every((s) => s === 'noop')) {
        vscode.window.showInformationMessage('Git Code Timer: git hooks already installed.');
      } else {
        vscode.window.showInformationMessage('Git Code Timer: git hooks installed.');
      }
    }
  } catch (e) {
    if (!silent) vscode.window.showErrorMessage(`Git Code Timer: hook install failed — ${e}`);
    log(`installHooks error: ${e}`);
  }
}

export async function uninstallHooks(): Promise<void> {
  const dir = gitDir();
  if (!dir) return;
  for (const name of ['prepare-commit-msg', 'post-commit']) {
    const p = path.join(dir, 'hooks', name);
    const body = await fs.readFile(p, 'utf8').catch(() => '');
    if (!body.includes(MARKER)) continue;

    const foreignPath = p + FOREIGN_SUFFIX;
    const foreignBody = await fs.readFile(foreignPath, 'utf8').catch(() => '');
    if (foreignBody) {
      // Restore the displaced hook in place of ours.
      await fs.writeFile(p, foreignBody, { mode: 0o755 });
      await fs.unlink(foreignPath).catch(() => {});
      log(`uninstall: restored foreign hook at ${p}`);
    } else {
      await fs.unlink(p).catch(() => {});
      log(`uninstall: removed our hook at ${p}`);
    }
  }
  const ef = elapsedFilePath();
  if (ef) await fs.unlink(ef).catch(() => {});
  vscode.window.showInformationMessage('Git Code Timer: git hooks removed.');
}

let lastWrittenElapsed: string | undefined;

export async function writeElapsed(text: string): Promise<void> {
  const p = elapsedFilePath();
  if (!p) return;
  if (text !== lastWrittenElapsed) {
    log(`writeElapsed → ${p}: "${text}"`);
    lastWrittenElapsed = text;
  }
  await fs.writeFile(p, text).catch((e) => log(`writeElapsed failed: ${e}`));
}

// Returns true when the elapsed file has been emptied externally
// (post-commit hook truncates it after a commit).
export async function elapsedWasCleared(): Promise<boolean> {
  const p = elapsedFilePath();
  if (!p) return false;
  const body = await fs.readFile(p, 'utf8').catch(() => null);
  const cleared = body === '';
  if (cleared) {
    log(`elapsedWasCleared: file at ${p} is empty — post-commit hook fired`);
    lastWrittenElapsed = undefined;
  }
  return cleared;
}
