// Builds the Obsidian plugin into plugin/dist.
//   node scripts/plugin.mjs                  build once
//   node scripts/plugin.mjs --vault <dir>    also install into <dir>/.obsidian/plugins/duet
//   node scripts/plugin.mjs --watch          rebuild and reinstall on every change
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { context } from 'esbuild';
import { obsidianBundle } from './esbuild-options.mjs';

const { values } = parseArgs({ options: { vault: { type: 'string' }, watch: { type: 'boolean' } } });
const DIST = 'plugin/dist';
const targets = [DIST, ...(values.vault ? [path.join(values.vault, '.obsidian/plugins/duet')] : [])];

/** Duet's own styles, then the styles of the Yami layer that the plugin bundles. */
async function styles() {
  const own = await readFile('plugin/styles.css', 'utf8');
  const yami = await readFile('node_modules/yami/src/obsidian/styles.css', 'utf8');
  return `${own.trimEnd()}\n\n${yami}`;
}

async function install() {
  const css = await styles();
  for (const target of targets) {
    await mkdir(target, { recursive: true });
    if (target !== DIST) await copyFile(path.join(DIST, 'main.js'), path.join(target, 'main.js'));
    await copyFile('manifest.json', path.join(target, 'manifest.json'));
    await writeFile(path.join(target, 'styles.css'), css);
  }
  console.log(`Plugin built${values.vault ? ` and installed in ${values.vault}` : ''}.`);
}

const ctx = await context({
  ...obsidianBundle,
  entryPoints: ['plugin/src/main.ts'],
  outfile: path.join(DIST, 'main.js'),
  logLevel: 'warning',
  plugins: [...obsidianBundle.plugins, { name: 'install', setup: (build) => build.onEnd((result) => (result.errors.length ? undefined : install())) }],
});

if (values.watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
