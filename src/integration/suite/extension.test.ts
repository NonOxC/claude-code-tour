import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveStepRange } from '../../tourController';
import { TourStep } from '../../tourTypes';

const EXTENSION_ID = 'matthew-you.claude-code-tour';

function step(extra: Partial<TourStep> = {}): TourStep {
  return { file: 'sample.ts', startLine: 1, endLine: 1, title: 't', explanation: 'e', ...extra };
}

async function openFixture(): Promise<vscode.TextDocument> {
  const folders = vscode.workspace.workspaceFolders;
  assert.ok(folders && folders.length > 0, 'the test workspace must be open');
  const uri = vscode.Uri.file(path.join(folders[0].uri.fsPath, 'sample.ts'));
  return vscode.workspace.openTextDocument(uri);
}

suite('activation', () => {
  test('the extension is present and activates', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} was not found`);
    await ext.activate();
    assert.equal(ext.isActive, true, 'the extension failed to activate');
  });

  test('activating registers every contributed command', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    await ext?.activate();
    const registered = await vscode.commands.getCommands(true);
    for (const id of [
      'claudeCodeTour.ask',
      'claudeCodeTour.next',
      'claudeCodeTour.prev',
      'claudeCodeTour.end',
      'claudeCodeTour.explainSelection',
    ]) {
      assert.ok(registered.includes(id), `command ${id} was never registered`);
    }
  });

  test('every contributed command and menu entry points at a real command', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext.activate();
    const registered = await vscode.commands.getCommands(true);

    const contributes = ext.packageJSON.contributes ?? {};
    const declared = new Set<string>((contributes.commands ?? []).map((c: { command: string }) => c.command));
    for (const id of declared) {
      assert.ok(registered.includes(id), `package.json declares ${id} but nothing registers it`);
    }

    // A menu or keybinding referencing a command that does not exist silently does
    // nothing when clicked, which is the kind of thing only a real host catches.
    const menuRefs = Object.values(contributes.menus ?? {}).flat() as { command?: string }[];
    for (const entry of menuRefs) {
      if (entry.command) {
        assert.ok(declared.has(entry.command), `menu references undeclared command ${entry.command}`);
      }
    }
    for (const kb of (contributes.keybindings ?? []) as { command: string }[]) {
      assert.ok(declared.has(kb.command), `keybinding references undeclared command ${kb.command}`);
    }
  });

  test('explainSelection is safe to invoke with no active editor', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('claudeCodeTour.explainSelection');
  });

  test('activates on startup so the status bar entry point exists before the panel is opened', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    // The panel lives in the Secondary Side Bar, which contributes no Activity Bar
    // icon. If the extension only woke on first view open, the status bar button -
    // the one always-visible way in - would not exist until you had already found
    // the panel some other way.
    assert.ok(
      (ext.packageJSON.activationEvents ?? []).includes('onStartupFinished'),
      'onStartupFinished is required for the status bar item to appear unprompted',
    );
  });

  test('the declared settings are readable with their documented defaults', async () => {
    const config = vscode.workspace.getConfiguration('claudeCodeTour');
    assert.equal(config.get('claudePath'), 'claude');
    assert.equal(config.get('model'), '');
    assert.equal(config.get('maxCostUsd'), 0);
    assert.equal(config.get('timeoutSeconds'), 300);
  });

  test('navigation commands are safe to invoke with no tour loaded', async () => {
    // These are reachable from the command palette at any time; they must no-op
    // rather than throw into the extension host.
    await vscode.commands.executeCommand('claudeCodeTour.next');
    await vscode.commands.executeCommand('claudeCodeTour.prev');
    await vscode.commands.executeCommand('claudeCodeTour.end');
  });
});

suite('resolveStepRange against a real TextDocument', () => {
  test('an exact anchor produces a range covering the intended lines', async () => {
    const doc = await openFixture();
    const resolved = resolveStepRange(doc, step({ anchor: 'function beta() {', startLine: 7, endLine: 9 }));

    assert.equal(resolved.resolution, 'exact');
    assert.equal(resolved.range.start.line, 6);
    assert.equal(resolved.range.end.line, 8);
    // The range must end at the true end of the last line, not at column 0.
    assert.equal(resolved.range.end.character, doc.lineAt(8).text.length);
    assert.equal(doc.getText(resolved.range).startsWith('function beta() {'), true);
  });

  test('a drifted anchor is re-located and reported as such', async () => {
    const doc = await openFixture();
    // Claim beta lives where alpha actually is; the anchor should win.
    const resolved = resolveStepRange(doc, step({ anchor: 'function beta() {', startLine: 3, endLine: 5 }));

    assert.equal(resolved.resolution, 'relocated');
    assert.equal(resolved.range.start.line, 6);
    assert.ok(resolved.note && /re-located/.test(resolved.note));
  });

  test('a vanished anchor is reported as unresolved rather than silently guessing', async () => {
    const doc = await openFixture();
    const resolved = resolveStepRange(doc, step({ anchor: 'function nonexistent() {', startLine: 3, endLine: 4 }));

    assert.equal(resolved.resolution, 'unresolved');
    assert.ok(resolved.note && /Could not find/.test(resolved.note));
  });

  test('out-of-range line numbers are clamped inside the document', async () => {
    const doc = await openFixture();
    const resolved = resolveStepRange(doc, step({ startLine: 9999, endLine: 10_000 }));

    assert.ok(resolved.range.start.line < doc.lineCount);
    assert.ok(resolved.range.end.line < doc.lineCount);
    assert.ok(resolved.range.end.line >= resolved.range.start.line);
  });

  test('the resulting range is always valid for the document', async () => {
    const doc = await openFixture();
    for (const s of [
      step({ startLine: -5, endLine: -9 }),
      step({ startLine: NaN, endLine: NaN }),
      step({ anchor: '  return 2;', startLine: 1, endLine: 400 }),
    ]) {
      const { range } = resolveStepRange(doc, s);
      // validateRange returns the same range only if it was already legal.
      assert.deepEqual(doc.validateRange(range), range, `invalid range produced for ${JSON.stringify(s)}`);
    }
  });
});
