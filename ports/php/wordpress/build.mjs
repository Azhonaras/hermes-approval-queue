/**
 * Assembles the installable plugin: dist/hermes-approval/ = the plugin + the PHP core copied into lib/
 * + the review page copied into ui/.
 * (The autoloader in hermes-approval.php finds the core in lib/ when installed, or two folders up in this repository.
 * The review page under Agent requests in wp-admin is ui/index.html; AdminPage.php serves it.)
 *
 *   node ports/php/wordpress/build.mjs        then zip dist/hermes-approval, or copy it to wp-content/plugins/
 */
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');
const plugin = path.join(here, 'hermes-approval');
const core = path.join(here, '..', 'core', 'src');
const demo = path.join(root, 'demo');
const client = path.join(root, 'src', 'client.js');
const out = path.join(here, 'dist', 'hermes-approval');

if (!existsSync(path.join(plugin, 'hermes-approval.php')) || !existsSync(core) || !existsSync(path.join(demo, 'index.html')) || !existsSync(client)) {
  console.error('Run this from a full checkout: the plugin, ports/php/core/src, demo/ and src/client.js must all exist.');
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(plugin, out, { recursive: true });
cpSync(core, path.join(out, 'lib'), { recursive: true });

// The review page: the same files as the demo. In the repository the page loads ../src/client.js; here it sits beside it.
const ui = path.join(out, 'ui');
mkdirSync(ui, { recursive: true });
const page = readFileSync(path.join(demo, 'index.html'), 'utf8');
if (!page.includes('src="../src/client.js"')) {
  console.error('demo/index.html no longer loads ../src/client.js: update build.mjs to match.');
  process.exit(1);
}
writeFileSync(path.join(ui, 'index.html'), page.replace('src="../src/client.js"', 'src="client.js"'));
cpSync(path.join(demo, 'styles.css'), path.join(ui, 'styles.css'));
cpSync(path.join(demo, 'js'), path.join(ui, 'js'), { recursive: true });
cpSync(client, path.join(ui, 'client.js'));
console.log('Built ' + out);
