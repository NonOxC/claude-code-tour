import * as vscode from 'vscode';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage } from './tourTypes';

export class TourPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claudeCodeTour.panel';

  private view: vscode.WebviewView | undefined;
  private handler: ((msg: WebviewToExtensionMessage) => void) | undefined;
  /**
   * Messages posted before the view exists are replayed in order once it does. This
   * has to be a queue, not a single slot: running the Ask command before ever opening
   * the sidebar posts 'loading' then 'plan' then 'step', and keeping only the last one
   * would leave the panel with a step index and no plan to index into.
   */
  private readonly pending: ExtensionToWebviewMessage[] = [];
  /** Set once the webview's own script has signalled it is listening. */
  private ready = false;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setMessageHandler(handler: (msg: WebviewToExtensionMessage) => void): void {
    this.handler = handler;
  }

  postMessage(msg: ExtensionToWebviewMessage): void {
    if (!this.view || !this.ready) {
      this.pending.push(msg);
      return;
    }
    void this.view.webview.postMessage(msg);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.ready = false;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
      // Wait for the webview to announce itself before replaying: posting into a
      // freshly-set html document can land before its listener is attached.
      if (msg.type === 'ready') {
        this.ready = true;
        this.flushPending();
        return;
      }
      this.handler?.(msg);
    });

    // A hidden view is disposed by VS Code; without this we would keep posting into
    // a dead webview and silently drop every message instead of re-queueing it.
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
        this.ready = false;
      }
    });
  }

  private flushPending(): void {
    if (!this.view || !this.ready) {
      return;
    }
    const queued = this.pending.splice(0, this.pending.length);
    for (const msg of queued) {
      void this.view.webview.postMessage(msg);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
  />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Claude Code Tour</title>
</head>
<body>
  <div id="app">
    <form id="ask-form">
      <input id="question-input" type="text" placeholder="Ask about this code..." autocomplete="off" />
      <button id="ask-btn" type="submit">Ask</button>
    </form>

    <div id="status-row">
      <!-- A squiggle that draws and redraws itself while a tour is being
           generated, so the wait reads as someone sketching rather than a
           frozen panel. Hidden unless busy. -->
      <svg id="doodle" viewBox="0 0 48 16" aria-hidden="true" hidden>
        <path pathLength="100" d="M2 9 C 6 2, 9 2, 12 8 S 18 15, 22 8 S 28 1, 32 8 S 39 15, 46 6" />
      </svg>
      <div id="status"></div>
      <button id="cancel-btn" type="button" hidden>Cancel</button>
    </div>

    <div id="progress-track" hidden><div id="progress-bar"></div></div>

    <div id="welcome">
      <p class="welcome-lead">Ask anything about this codebase and get a guided walkthrough.</p>
      <div id="suggestions">
        <button class="suggestion" type="button">How is this project structured?</button>
        <button class="suggestion" type="button">Where does the app start, and what happens first?</button>
        <button class="suggestion" type="button">How does data flow through this app?</button>
        <button class="suggestion" type="button">Where is state managed?</button>
      </div>
      <p class="welcome-hint">Tip: select code in the editor, right-click, and choose <em>Explain This With a Tour</em>.</p>
    </div>

    <div id="summary"></div>

    <div id="step-panel">
      <div id="step-progress"></div>
      <div id="step-warning" hidden></div>
      <div id="step-title"></div>
      <div id="step-explanation"></div>
      <details id="step-snapshot" hidden>
        <summary>Show the code this step was written about</summary>
        <pre><code id="step-snapshot-code"></code></pre>
      </details>
    </div>

    <div id="nav">
      <button id="prev-btn" type="button">◀ Prev</button>
      <button id="next-btn" type="button">Next ▶</button>
      <button id="end-btn" type="button">End tour</button>
    </div>

    <nav id="outline" aria-label="Tour steps"></nav>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
