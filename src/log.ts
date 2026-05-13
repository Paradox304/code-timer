import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function initLog(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel('Git Code Timer');
  return channel;
}

export function log(msg: string): void {
  if (!channel) return;
  const ts = new Date().toISOString();
  channel.appendLine(`[${ts}] ${msg}`);
}
