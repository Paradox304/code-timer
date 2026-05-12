import * as vscode from 'vscode';
import { Timer, TimerConfig } from './timer';
import { formatElapsed } from './format';
import {
  installHooks,
  uninstallHooks,
  writeElapsed,
  elapsedWasCleared,
} from './gitHook';

interface FullConfig extends TimerConfig {
  inject: boolean;
  displayFormat: string;
  gitFormat: string;
  promptOnReturn: boolean;
}

function readConfig(): FullConfig {
  const c = vscode.workspace.getConfiguration('codeTimer');
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

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'codeTimer.actions';
  context.subscriptions.push(statusBar);

  const refresh = (): void => {
    const cfg = readConfig();
    const text = formatElapsed(cfg.displayFormat, timer.getSeconds()) || '0';
    const icon = timer.isActive() ? '$(record)' : '$(clock)';
    statusBar.text = `${icon} ${text}`;
    statusBar.tooltip = new vscode.MarkdownString(
      `**Code Timer** — ${timer.isActive() ? 'active' : 'paused'}\n\n` +
      `Click for actions.`
    );
    statusBar.show();
  };

  let awayPromptOpen = false;
  const handleResumeFromPause = async (awaySeconds: number): Promise<void> => {
    const cfg = readConfig();
    if (!cfg.promptOnReturn || awayPromptOpen) return;
    awayPromptOpen = true;
    try {
      const label = formatAway(awaySeconds);
      const COUNT = `Count ${label}`;
      const choice = await vscode.window.showInformationMessage(
        `Welcome back — you were away for ${label}. Count it as work time?`,
        COUNT,
        'Skip',
      );
      if (choice === COUNT) timer.adjust(awaySeconds);
    } finally {
      awayPromptOpen = false;
    }
  };

  const timer = new Timer(
    context.workspaceState,
    () => {
      const c = readConfig();
      return { pauseAfter: c.pauseAfter, autoStart: c.autoStart };
    },
    refresh,
    handleResumeFromPause,
  );
  context.subscriptions.push({ dispose: () => timer.dispose() });

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== 'file') return;
      timer.onKeystroke();
    }),
  );

  const tick = setInterval(async () => {
    if (timer.isActive()) refresh();

    const cfg = readConfig();
    if (cfg.inject) {
      if (await elapsedWasCleared()) {
        // post-commit hook emptied the file → reset and start fresh.
        if (timer.getSeconds() > 0) timer.reset();
      }
      const line = formatElapsed(cfg.gitFormat, timer.getSeconds());
      await writeElapsed(line);
    }
  }, 1000);
  context.subscriptions.push({ dispose: () => clearInterval(tick) });

  const reg = (id: string, fn: () => void | Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('codeTimer.reset', () => timer.reset());
  reg('codeTimer.toggle', () => (timer.isActive() ? timer.pause() : timer.resume()));
  reg('codeTimer.addHour', () => timer.adjust(3600));
  reg('codeTimer.add5Min', () => timer.adjust(300));
  reg('codeTimer.add30Sec', () => timer.adjust(30));
  reg('codeTimer.sub30Sec', () => timer.adjust(-30));
  reg('codeTimer.sub5Min', () => timer.adjust(-300));
  reg('codeTimer.subHour', () => timer.adjust(-3600));
  reg('codeTimer.installGitHook', () => installHooks(false));
  reg('codeTimer.uninstallGitHook', () => uninstallHooks());

  reg('codeTimer.actions', async () => {
    const items: (vscode.QuickPickItem & { run: () => void | Promise<void> })[] = [
      {
        label: timer.isActive() ? '$(debug-pause) Pause' : '$(play) Resume',
        run: () => (timer.isActive() ? timer.pause() : timer.resume()),
      },
      { label: '$(refresh) Reset', run: () => timer.reset() },
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
        run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'codeTimer'),
      },
    ];
    const cfg = readConfig();
    const display = formatElapsed(cfg.displayFormat, timer.getSeconds()) || '0';
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: `Code Timer — ${display} (${timer.isActive() ? 'active' : 'paused'})`,
    });
    if (pick) await pick.run();
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codeTimer')) refresh();
    }),
  );

  if (readConfig().inject) void installHooks(true);

  refresh();
}

export function deactivate(): void {}
