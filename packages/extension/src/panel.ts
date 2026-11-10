import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { getLocale, t, type PanelToExt } from '@css-tuner/protocol';
import type { Controller } from './controller';

export class PanelProvider implements vscode.WebviewViewProvider {
  static readonly id = 'cssTuner.panel';
  private view: vscode.WebviewView | null = null;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly controller: Controller,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'panel');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    const attach = this.controller.attachPanel((msg) => void view.webview.postMessage(msg));
    const sub = view.webview.onDidReceiveMessage((msg: PanelToExt) => void this.controller.handle(msg));
    view.onDidDispose(() => {
      attach.dispose();
      sub.dispose();
      this.view = null;
    });
  }

  reveal() {
    if (this.view) this.view.show(true);
    else void vscode.commands.executeCommand(`${PanelProvider.id}.focus`);
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    if (!existsSync(join(media.fsPath, 'index.js'))) {
      return `<!doctype html><html lang="${getLocale()}"><body style="font-family:var(--vscode-font-family);padding:12px;color:var(--vscode-foreground)">${t('ext.panel.missing')}</body></html>`;
    }
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'index.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'index.css'));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob: http: https:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    ].join('; ');
    return `<!doctype html>
<html lang="${getLocale()}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
