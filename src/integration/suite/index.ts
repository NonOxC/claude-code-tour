import * as path from 'path';
import Mocha from 'mocha';

/**
 * Entry point loaded inside the VS Code extension host. Mocha is used here (rather
 * than the node:test runner the unit suite uses) because it can be driven
 * programmatically from within the host process, which node:test cannot.
 */
export function run(): Promise<void> {
  // 'tdd' provides suite()/test(), the convention VS Code's own extension samples use.
  const mocha = new Mocha({ ui: 'tdd', color: false, timeout: 30_000 });
  mocha.addFile(path.resolve(__dirname, 'extension.test.js'));

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} integration test(s) failed.`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
