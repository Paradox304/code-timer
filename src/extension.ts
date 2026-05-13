import * as vscode from 'vscode';
import { Timer, TimerConfig, PersistedState } from './timer';
import { formatElapsed } from './format';
import {
  installHooks,
  uninstallHooks,
  writeElapsed,
  elapsedWasCleared,
} from './gitHook';
import { readState, writeState, stateFilePath } from './stateFile';

interface FullConfig extends TimerConfig {
  inject: boolean;
  displayFormat: string;
  gitFormat: string;
  promptOnReturn: boolean;
}

const LEGACY_STATE_KEY = 'codeTimer.seconds';

function readConfig(): FullConfig {
  const c = vscode.workspace.getConfiguration('gitCodeTimer');
  return {
    pauseAfter: c.get<number>('pauseAfterSeconds', 120),
    autoStart: c.get<boolean>('autoStartOnTyping', true),
    inject: c.get<boolean>('injectIntoCommits', true),
    displayFormat: c.get<string>('displayFormat', '{{hours "hr"s}} {{minutes "min"}} {{seconds "sec"}}'),
    gitFormat: c.get<string>('gitFormat', 'Took {{hours "hour"s}} {{minutes "minute"s}} {{seconds "second"s}}'),
    promptOnReturn: c.get<boolean>('promptOnReturn', true)
  };
}

function formatAway(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} sec`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} hr` : `${h} hr ${rem} min`;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'gitCodeTimer.actions';
  context.subscriptions.push(statusBar);

  // Load initial state: prefer the committed file; fall back to legacy memento.
  const fromFile = await readState();
  const legacy = context.workspaceState.get<number>(LEGACY_STATE_KEY, 0);
  const initial: PersistedState = fromFile ?? { total: legacy, current: legacy };

  let lastWritten = JSON.stringify(initial);

  const persist = (state: PersistedState): void => {
    const serialized = JSON.stringify({
      total: Math.round(state.total),
      current: Math.round(state.current),
    });
    if (serialized === lastWritten) return;
    lastWritten = serialized;
    void writeState(state);
    void context.workspaceState.update(LEGACY_STATE_KEY, state.current);
  };

  const refresh = (): void => {
    const cfg = readConfig();
    const text = formatElapsed(cfg.displayFormat, timer.getSeconds()) || '0';
    const icon = timer.isActive() ? '$(record)' : '$(clock)';
    statusBar.text = `${icon} ${text}`;
    const totalText = formatElapsed(cfg.displayFormat, timer.getTotal()) || '0';
    statusBar.tooltip = new vscode.MarkdownString(
      `**Git Code Timer** — ${timer.isActive() ? 'active' : 'paused'}\n\n` +
      `Since last commit: **${text}**\n\n` +
      `Lifetime on this repo: **${totalText}**\n\n` +
      `Click for actions.`
    );
    statusBar.show();
  };

  const handleResumeFromPause = async (awaySeconds: number): Promise<void> => {
    const cfg = readConfig();
    if (!cfg.promptOnReturn) return;
    const label = formatAway(awaySeconds);
    const COUNT = `Count ${label}`;
    const choice = await vscode.window.showInformationMessage(
      `Welcome back — you were away for ${label}. Count it as work time?`,
      COUNT,
      'Skip',
    );
    if (choice === COUNT) timer.adjust(awaySeconds);
  };

  const timer = new Timer(
    initial,
    () => {
      const c = readConfig();
      return { pauseAfter: c.pauseAfter, autoStart: c.autoStart };
    },
    persist,
    refresh,
    handleResumeFromPause,
  );
  context.subscriptions.push({ dispose: () => timer.dispose() });

  // Write the loaded state through once so the file exists on disk.
  persist(initial);

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== 'file') return;
      timer.onKeystroke();
    }),
  );

  // Watch the state file for external edits (e.g., teammate's commit pulled
  // in via `git pull` updates `total`). Re-create the watcher if the
  // `stateFile` setting changes.
  let watcher: vscode.FileSystemWatcher | undefined;
  const reload = async (): Promise<void> => {
    const next = await readState();
    if (!next) return;
    const serialized = JSON.stringify(next);
    if (serialized === lastWritten) return;
    lastWritten = serialized;
    timer.setState(next);
  };
  const installWatcher = (): void => {
    watcher?.dispose();
    watcher = undefined;
    const p = stateFilePath();
    if (!p) return;
    watcher = vscode.workspace.createFileSystemWatcher(p);
    watcher.onDidChange(reload);
    watcher.onDidCreate(reload);
  };
  installWatcher();
  context.subscriptions.push({ dispose: () => watcher?.dispose() });

  const tick = setInterval(async () => {
    if (timer.isActive()) refresh();

    const cfg = readConfig();
    if (cfg.inject) {
      if (await elapsedWasCleared()) {
        // post-commit hook emptied the file → reset current count.
        if (timer.getSeconds() > 0) timer.reset();
      }
      const line = formatElapsed(cfg.gitFormat, timer.getSeconds());
      await writeElapsed(line);
    }
  }, 1000);
  context.subscriptions.push({ dispose: () => clearInterval(tick) });

  const reg = (id: string, fn: () => void | Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('gitCodeTimer.reset', () => timer.reset());
  reg('gitCodeTimer.resetTotal', async () => {
    const choice = await vscode.window.showWarningMessage(
      'Reset lifetime total to 0? This cannot be undone.',
      { modal: true },
      'Reset Total',
    );
    if (choice === 'Reset Total') timer.resetTotal();
  });
  reg('gitCodeTimer.toggle', () => (timer.isActive() ? timer.pause() : timer.resume()));
  reg('gitCodeTimer.addHour', () => timer.adjust(3600));
  reg('gitCodeTimer.add5Min', () => timer.adjust(300));
  reg('gitCodeTimer.add30Sec', () => timer.adjust(30));
  reg('gitCodeTimer.sub30Sec', () => timer.adjust(-30));
  reg('gitCodeTimer.sub5Min', () => timer.adjust(-300));
  reg('gitCodeTimer.subHour', () => timer.adjust(-3600));
  reg('gitCodeTimer.installGitHook', () => installHooks(false));
  reg('gitCodeTimer.uninstallGitHook', () => uninstallHooks());

  reg('gitCodeTimer.actions', async () => {
    const items: (vscode.QuickPickItem & { run: () => void | Promise<void> })[] = [
      {
        label: timer.isActive() ? '$(debug-pause) Pause' : '$(play) Resume',
        run: () => (timer.isActive() ? timer.pause() : timer.resume()),
      },
      { label: '$(refresh) Reset Current', run: () => timer.reset() },
      {
        label: '$(trash) Reset Total',
        run: () => vscode.commands.executeCommand('gitCodeTimer.resetTotal'),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, run: () => {} },
      { label: '$(add) +1 hour', run: () => timer.adjust(3600) },
      { label: '$(add) +5 minutes', run: () => timer.adjust(300) },
      { label: '$(add) +30 seconds', run: () => timer.adjust(30) },
      { label: '$(remove) -30 seconds', run: () => timer.adjust(-30) },
      { label: '$(remove) -5 minutes', run: () => timer.adjust(-300) },
      { label: '$(remove) -1 hour', run: () => timer.adjust(-3600) },
      { label: '', kind: vscode.QuickPickItemKind.Separator, run: () => {} },
      {
        label: '$(gear) Open Settings…',
        run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'gitCodeTimer'),
      },
    ];
    const cfg = readConfig();
    const display = formatElapsed(cfg.displayFormat, timer.getSeconds()) || '0';
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: `Git Code Timer — ${display} (${timer.isActive() ? 'active' : 'paused'})`,
    });
    if (pick) await pick.run();
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('gitCodeTimer')) return;
      if (e.affectsConfiguration('gitCodeTimer.stateFile')) {
        // Path changed: re-watch the new path. If the new file already
        // exists, adopt its values; otherwise write current state to it.
        installWatcher();
        const next = await readState();
        if (next) {
          lastWritten = JSON.stringify(next);
          timer.setState(next);
        } else {
          lastWritten = '';
          persist({ total: timer.getTotal(), current: timer.getSeconds() });
        }
      }
      refresh();
    }),
  );

  if (readConfig().inject) void installHooks(true);

  refresh();
}

export function deactivate(): void {}
