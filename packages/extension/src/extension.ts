import * as vscode from 'vscode';

// Kerangka minimal (iterasi 1). Engine worker dan webview ditambahkan bertahap.
export function activate(context: vscode.ExtensionContext): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.text = 'RepoMind: belum diindeks';
  status.command = 'repomind.start';
  status.show();
  context.subscriptions.push(
    status,
    vscode.commands.registerCommand('repomind.start', () => {
      void vscode.window.showInformationMessage('RepoMind: analisis belum diimplementasikan (iterasi 1).');
    })
  );
}
export function deactivate(): void {}
