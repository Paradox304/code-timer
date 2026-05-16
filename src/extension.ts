import * as vscode from 'vscode';
import { Timer, TimerConfig, PersistedState } from './timer';
import { formatElapsed } from './format';
import {
  installHooks,
  uninstallHooks,
  writeElapsed,
  elapsedWasCleared,
  InstallResult,
} from './gitHook';
import { readState, writeState, stateFilePath } from './stateFile';
import { initLog, log } from './log';

interface FullConfig extends TimerConfig {
  inject: boolean;
  displayFormat: string;
  gitFormat: string;
  promptOnReturn: boolean;
}

const LEGACY_STATE_KEY = 'codeTimer.seconds';

// Settings are read per workspace folder so a multi-root workspace can
// override any of them per repository.
function readConfig(scope?: vscode.Uri): FullConfig {
  const c = vscode.workspace.getConfiguration('gitCodeTimer', scope);
  return {
    pauseAfter: c.get<number>('pauseAfterSeconds', 120),
    autoStart: c.get<boolean>('autoStartOnTyping', true),
    inject: c.get<boolean>('injectIntoCommits', true),
    displayFormat: c.get<string>('displayFormat', '{{hours "hr"s}} {{minutes "min"}} {{seconds "sec"}}'),
    gitFormat: c.get<string>('gitFormat', 'Took {{hours "hour"s}} {{minutes "minute"s}} {{seconds "second"s}}'),
    promptOnReturn: c.get<boolean>('promptOnReturn', true),
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

// One timer + persistence context per workspace folder.
interface RepoEntry {
  folder: vscode.WorkspaceFolder;
  root: string;
  timer: Timer;
  lastWritten: string;
  watcher?: vscode.FileSystemWatcher;
  lastActivity: number; // Date.now() of the last keystroke routed here
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = initLog();
  context.subscriptions.push(channel);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'gitCodeTimer.actions';
  context.subscriptions.push(statusBar);

  const repos = new Map<string, RepoEntry>();
  // Key of the repo whose timer the status bar currently reflects.
  let activeKey: string | undefined;

  const keyOf = (folder: vscode.WorkspaceFolder): string => folder.uri.toString();
  const legacyKey = (folder: vscode.WorkspaceFolder): string =>
    folder.index === 0 ? LEGACY_STATE_KEY : `${LEGACY_STATE_KEY}:${folder.uri.toString()}`;

  const repoForUri = (uri: vscode.Uri): RepoEntry | undefined => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? repos.get(keyOf(folder)) : undefined;
  };

  const activeRepo = (): RepoEntry | undefined => {
    if (activeKey && repos.has(activeKey)) return repos.get(activeKey);
    return repos.values().next().value as RepoEntry | undefined;
  };

  const refresh = (): void => {
    const entry = activeRepo();
    if (!entry) {
      statusBar.hide();
      return;
    }
    const cfg = readConfig(entry.folder.uri);
    const text = formatElapsed(cfg.displayFormat, entry.timer.getSeconds()) || '0';
    const icon = entry.timer.isActive() ? '$(record)' : '$(clock)';
    const multi = repos.size > 1;
    statusBar.text = multi
      ? `${icon} ${text} · ${entry.folder.name}`
      : `${icon} ${text}`;

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Git Code Timer**\n\n`);
    if (multi) {
      md.appendMarkdown(`Tracking **${repos.size}** repositories — typing routes time to the repo owning the edited file.\n\n`);
      md.appendMarkdown(`| Repository | Since commit | Lifetime | |\n`);
      md.appendMarkdown(`| --- | --- | --- | --- |\n`);
      for (const e of repos.values()) {
        const ec = readConfig(e.folder.uri);
        const cur = formatElapsed(ec.displayFormat, e.timer.getSeconds()) || '0';
        const tot = formatElapsed(ec.displayFormat, e.timer.getTotal()) || '0';
        const here = e.timer.isActive() ? '$(record)' : '$(clock)';
        const marker = keyOf(e.folder) === keyOf(entry.folder) ? ' ◀ active' : '';
        md.appendMarkdown(`| ${here} ${e.folder.name} | ${cur} | ${tot} |${marker} |\n`);
      }
      md.appendMarkdown(`\nClick for actions on **${entry.folder.name}**.`);
    } else {
      const totalText = formatElapsed(cfg.displayFormat, entry.timer.getTotal()) || '0';
      md.appendMarkdown(
        `Status: **${entry.timer.isActive() ? 'active' : 'paused'}**\n\n` +
        `Since last commit: **${text}**\n\n` +
        `Lifetime on this repo: **${totalText}**\n\n` +
        `Click for actions.`,
      );
    }
    md.supportThemeIcons = true;
    statusBar.tooltip = md;
    statusBar.show();
  };

  const handleResumeFromPause = async (
    entry: RepoEntry,
    awaySeconds: number,
  ): Promise<void> => {
    const cfg = readConfig(entry.folder.uri);
    if (!cfg.promptOnReturn) return;
    const label = formatAway(awaySeconds);
    const where = repos.size > 1 ? ` in "${entry.folder.name}"` : '';
    const COUNT = `Count ${label}`;
    const choice = await vscode.window.showInformationMessage(
      `Welcome back — you were away for ${label}${where}. Count it as work time?`,
      COUNT,
      'Skip',
    );
    if (choice === COUNT) entry.timer.adjust(awaySeconds);
  };

  const installWatcher = (entry: RepoEntry): void => {
    entry.watcher?.dispose();
    entry.watcher = undefined;
    const p = stateFilePath(entry.root);
    const reload = async (): Promise<void> => {
      const next = await readState(entry.root);
      if (!next) return;
      const serialized = JSON.stringify(next);
      if (serialized === entry.lastWritten) return;
      entry.lastWritten = serialized;
      entry.timer.setState(next);
    };
    const w = vscode.workspace.createFileSystemWatcher(p);
    w.onDidChange(reload);
    w.onDidCreate(reload);
    entry.watcher = w;
  };

  const createRepo = async (folder: vscode.WorkspaceFolder): Promise<RepoEntry> => {
    const root = folder.uri.fsPath;
    const fromFile = await readState(root);
    const legacy = context.workspaceState.get<number>(legacyKey(folder), 0);
    const initial: PersistedState = fromFile ?? { total: legacy, current: legacy };

    const entry: RepoEntry = {
      folder,
      root,
      lastWritten: JSON.stringify(initial),
      lastActivity: 0,
      timer: undefined as unknown as Timer, // assigned just below
    };

    const persist = (state: PersistedState): void => {
      const serialized = JSON.stringify({
        total: Math.round(state.total),
        current: Math.round(state.current),
      });
      if (serialized === entry.lastWritten) return;
      entry.lastWritten = serialized;
      void writeState(root, state);
      void context.workspaceState.update(legacyKey(folder), state.current);
    };

    entry.timer = new Timer(
      initial,
      () => {
        const c = readConfig(folder.uri);
        return { pauseAfter: c.pauseAfter, autoStart: c.autoStart };
      },
      persist,
      refresh,
      (awaySeconds) => void handleResumeFromPause(entry, awaySeconds),
    );

    repos.set(keyOf(folder), entry);
    persist(initial); // ensure the state file exists on disk
    installWatcher(entry);
    log(`createRepo: ${folder.name} (${root})`);

    if (readConfig(folder.uri).inject) void installHooks(root);
    return entry;
  };

  const disposeRepo = (key: string): void => {
    const entry = repos.get(key);
    if (!entry) return;
    entry.watcher?.dispose();
    entry.timer.dispose();
    repos.delete(key);
    if (activeKey === key) activeKey = undefined;
    log(`disposeRepo: ${entry.folder.name}`);
  };

  // Pick the repo the status bar follows: most-recently-typed-in, or the
  // folder owning the focused editor, or the first folder.
  const focusActiveRepoFromEditor = (): void => {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.uri.scheme !== 'file') return;
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (folder && repos.has(keyOf(folder))) activeKey = keyOf(folder);
  };

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    await createRepo(folder);
  }
  focusActiveRepoFromEditor();

  context.subscriptions.push({
    dispose: () => {
      for (const key of [...repos.keys()]) disposeRepo(key);
    },
  });

  // Route every keystroke to the repo that owns the edited file.
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== 'file') return;
      const entry = repoForUri(e.document.uri);
      if (!entry) return;
      entry.lastActivity = Date.now();
      activeKey = keyOf(entry.folder);
      entry.timer.onKeystroke();
    }),
  );

  // Following the focused editor keeps the status bar showing the repo the
  // user is looking at, even before they type.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      focusActiveRepoFromEditor();
      refresh();
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
      for (const removed of e.removed) disposeRepo(keyOf(removed));
      for (const added of e.added) await createRepo(added);
      focusActiveRepoFromEditor();
      refresh();
    }),
  );

  const tick = setInterval(async () => {
    if ([...repos.values()].some((e) => e.timer.isActive())) refresh();

    for (const entry of repos.values()) {
      const cfg = readConfig(entry.folder.uri);
      if (!cfg.inject) continue;
      if (await elapsedWasCleared(entry.root)) {
        if (entry.timer.getSeconds() > 0) {
          log(`tick: resetting current for ${entry.folder.name} after post-commit clear`);
          entry.timer.reset();
        }
      }
      const line = formatElapsed(cfg.gitFormat, entry.timer.getSeconds());
      await writeElapsed(entry.root, line);
    }
  }, 1000);
  context.subscriptions.push({ dispose: () => clearInterval(tick) });

  const reg = (id: string, fn: () => void | Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  const onActive = (fn: (t: Timer) => void): void => {
    const entry = activeRepo();
    if (entry) fn(entry.timer);
  };

  reg('gitCodeTimer.pauseAll', () => {
    for (const entry of repos.values()) {
      if (entry.timer.isActive()) entry.timer.pause();
    }
    refresh();
  });
  reg('gitCodeTimer.reset', () => onActive((t) => t.reset()));
  reg('gitCodeTimer.resetTotal', async () => {
    const entry = activeRepo();
    if (!entry) return;
    const where = repos.size > 1 ? ` for "${entry.folder.name}"` : '';
    const choice = await vscode.window.showWarningMessage(
      `Reset lifetime total${where} to 0? This cannot be undone.`,
      { modal: true },
      'Reset Total',
    );
    if (choice === 'Reset Total') entry.timer.resetTotal();
  });
  reg('gitCodeTimer.toggle', () =>
    onActive((t) => (t.isActive() ? t.pause() : t.resume())));
  reg('gitCodeTimer.addHour', () => onActive((t) => t.adjust(3600)));
  reg('gitCodeTimer.add5Min', () => onActive((t) => t.adjust(300)));
  reg('gitCodeTimer.add30Sec', () => onActive((t) => t.adjust(30)));
  reg('gitCodeTimer.sub30Sec', () => onActive((t) => t.adjust(-30)));
  reg('gitCodeTimer.sub5Min', () => onActive((t) => t.adjust(-300)));
  reg('gitCodeTimer.subHour', () => onActive((t) => t.adjust(-3600)));

  const summarizeInstall = (results: { name: string; r: InstallResult }[]): void => {
    const ok = results.filter((x) => x.r === 'installed').map((x) => x.name);
    const noop = results.filter((x) => x.r === 'noop').map((x) => x.name);
    const skipped = results.filter((x) => x.r === 'skipped').map((x) => x.name);
    const noGit = results.filter((x) => x.r === 'no-git').map((x) => x.name);
    const parts: string[] = [];
    if (ok.length) parts.push(`installed in ${ok.join(', ')}`);
    if (noop.length) parts.push(`already present in ${noop.join(', ')}`);
    if (skipped.length) parts.push(`skipped in ${skipped.join(', ')}`);
    if (noGit.length) parts.push(`no git repo: ${noGit.join(', ')}`);
    const msg = `Git Code Timer: hooks ${parts.join('; ') || 'unchanged'}.`;
    if (skipped.length) vscode.window.showWarningMessage(msg);
    else vscode.window.showInformationMessage(msg);
  };

  reg('gitCodeTimer.installGitHook', async () => {
    const results: { name: string; r: InstallResult }[] = [];
    for (const entry of repos.values()) {
      results.push({ name: entry.folder.name, r: await installHooks(entry.root) });
    }
    summarizeInstall(results);
  });
  reg('gitCodeTimer.uninstallGitHook', async () => {
    const removed: string[] = [];
    for (const entry of repos.values()) {
      if (await uninstallHooks(entry.root)) removed.push(entry.folder.name);
    }
    vscode.window.showInformationMessage(
      removed.length
        ? `Git Code Timer: hooks removed from ${removed.join(', ')}.`
        : 'Git Code Timer: no hooks to remove.',
    );
  });

  reg('gitCodeTimer.actions', async () => {
    const entry = activeRepo();
    if (!entry) return;
    const t = entry.timer;
    const items: (vscode.QuickPickItem & { run: () => void | Promise<void> })[] = [
      {
        label: t.isActive() ? '$(debug-pause) Pause' : '$(play) Resume',
        run: () => (t.isActive() ? t.pause() : t.resume()),
      },
      ...(repos.size > 1
        ? [{
            label: '$(debug-pause) Pause All Repos',
            run: () => vscode.commands.executeCommand('gitCodeTimer.pauseAll'),
          }]
        : []),
      { label: '$(refresh) Reset Current', run: () => t.reset() },
      {
        label: '$(trash) Reset Total',
        run: () => vscode.commands.executeCommand('gitCodeTimer.resetTotal'),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, run: () => {} },
      { label: '$(add) +1 hour', run: () => t.adjust(3600) },
      { label: '$(add) +5 minutes', run: () => t.adjust(300) },
      { label: '$(add) +30 seconds', run: () => t.adjust(30) },
      { label: '$(remove) -30 seconds', run: () => t.adjust(-30) },
      { label: '$(remove) -5 minutes', run: () => t.adjust(-300) },
      { label: '$(remove) -1 hour', run: () => t.adjust(-3600) },
      { label: '', kind: vscode.QuickPickItemKind.Separator, run: () => {} },
      {
        label: '$(gear) Open Settings…',
        run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'gitCodeTimer'),
      },
    ];
    const cfg = readConfig(entry.folder.uri);
    const display = formatElapsed(cfg.displayFormat, t.getSeconds()) || '0';
    const scope = repos.size > 1 ? ` · ${entry.folder.name}` : '';
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: `Git Code Timer${scope} — ${display} (${t.isActive() ? 'active' : 'paused'})`,
    });
    if (pick) await pick.run();
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('gitCodeTimer')) return;
      if (e.affectsConfiguration('gitCodeTimer.stateFile')) {
        // Path changed: re-watch each folder's new path. Adopt an existing
        // file's values, or seed it with the timer's current state.
        for (const entry of repos.values()) {
          installWatcher(entry);
          const next = await readState(entry.root);
          if (next) {
            entry.lastWritten = JSON.stringify(next);
            entry.timer.setState(next);
          } else {
            entry.lastWritten = '';
            void writeState(entry.root, {
              total: entry.timer.getTotal(),
              current: entry.timer.getSeconds(),
            });
          }
        }
      }
      refresh();
    }),
  );

  refresh();
}

export function deactivate(): void {}
