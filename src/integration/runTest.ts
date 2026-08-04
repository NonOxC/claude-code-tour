import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Launches a real VS Code instance with this extension loaded and runs the suite
 * inside it. This is the only way to prove the things the unit tests cannot: that
 * the extension actually activates from its contributed view, that its commands
 * register, and that range resolution produces ranges a real TextDocument accepts.
 */
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  // A throwaway workspace, so the tests never depend on the developer's own files.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cct-integration-'));
  fs.writeFileSync(
    path.join(workspace, 'sample.ts'),
    [
      'import fs from "fs";',
      '',
      'function alpha() {',
      '  return 1;',
      '}',
      '',
      'function beta() {',
      '  return 2;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspace,
        '--disable-extensions', // isolate: only the extension under test loads
        '--disable-gpu',
        '--no-sandbox',
      ],
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Integration tests failed:', err);
  process.exit(1);
});
