/**
 * build-plugin.mjs — bundle the Avatar Lab into a DSH Cordis client plugin.
 *
 * DSH loads browser plugins as plain CommonJS-ish factory modules registered on
 * `window.__ModuleLoader__`:
 *
 *   window.__ModuleLoader__.load({
 *     id: "<package name>",
 *     factory: (require) => { ... module.exports ... },
 *   })
 *
 * React and react-dom are NOT bundled: they are externals provided by the
 * loader's own module table, so the plugin must never ship its own copy (two
 * React instances in one page break hooks).
 *
 * Two CSS Module bundles also have to be inlined, because the DSH loader
 * executes a single JS artifact with no sidecar CSS request:
 *   - `*.module.css` — esbuild's `local-css` loader hashes the class names and
 *     puts the mapping on the default export, which is exactly the shape the
 *     `.tsx` components already expect.
 *   - `src/lab/lab.css` — a plain global sheet, imported for its side effect;
 *     esbuild's `css` loader would emit a separate file, so it is read and
 *     injected as text instead.
 *
 * Output: dist/plugin/client.js  (+ a copy of the package manifest)
 */

import { build } from 'esbuild';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'dist/plugin');
const PLUGIN_ID = 'dsh-avatar-lab';

/**
 * esbuild plugin: inline all CSS (both flavours) into the JS bundle.
 *
 * Two cases, and both must end up as runtime style injection because DSH's
 * plugin route serves exactly one JS artifact per plugin — a sibling `.css`
 * would never be requested by the browser.
 *
 *   `*.module.css` — CSS Modules. esbuild's built-in `local-css` loader cannot
 *     be used here because with `write: false` it insists on an output path for
 *     the extracted stylesheet. So the transform is done directly: every class
 *     selector is rewritten to `<File>_<name>_<hash>` and the mapping is
 *     exported as the module's default export — the exact shape the `.tsx`
 *     components import.
 *
 *     The original class name is kept as a *substring* of the hashed name.
 *     That is deliberate: the browser verification harness locates UI elements
 *     with `[class*="stateName"]`, and a hash that discarded the source name
 *     would make the page untestable.
 *
 *   `*.css` — a plain global sheet, injected verbatim.
 */

const CSS_IDENT = /\.([A-Za-z_][A-Za-z0-9_-]*)/g;

/** Stable, short, deterministic hash (fnv-1a) so builds are reproducible. */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).slice(0, 5);
}

/** Emit a style tag once, keyed by a stable id. */
function styleInjector(id, css, pluginId) {
  return `
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="' + ${JSON.stringify(id)} + '"]')) {
      const tag = document.createElement('style');
      tag.dataset.plugin = ${JSON.stringify(pluginId)};
      tag.dataset.pluginCss = ${JSON.stringify(id)};
      tag.textContent = ${JSON.stringify(css)};
      document.head.appendChild(tag);
    }
  `;
}

const inlineCss = {
  name: 'inline-css',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /\.css$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      const fileName = args.path.split('/').pop() ?? 'style.css';
      const id = `avatar-lab/${fileName}`;

      if (!args.path.includes('.module.css')) {
        return {
          loader: 'js',
          contents: `${styleInjector(id, source, PLUGIN_ID)}
export default undefined;\n`,
        };
      }

      // ── CSS Modules ──────────────────────────────────────────────────
      const base = fileName.replace(/\.module\.css$/, '');
      const mapping = Object.create(null);
      const scoped = source.replace(CSS_IDENT, (_match, name) => {
        if (!mapping[name]) {
          mapping[name] = `${base}_${name}_${hash(`${fileName}:${name}`)}`;
        }
        return `.${mapping[name]}`;
      });

      const entries = Object.keys(mapping)
        .map((k) => `${JSON.stringify(k)}: ${JSON.stringify(mapping[k])}`)
        .join(',\n  ');

      return {
        loader: 'js',
        contents:
          `${styleInjector(id, scoped, PLUGIN_ID)}\n` +
          `export default {\n  ${entries}\n};\n`,
      };
    });
  },
};

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  // ── 1. Bundle the client half to an IIFE that assigns module.exports ──
  const result = await build({
    entryPoints: [resolve(ROOT, 'src/plugin/client.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__avatarLabModule',
    platform: 'browser',
    target: 'es2022',
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    minify: true,
    legalComments: 'none',
    plugins: [inlineCss],
    // React is provided by the DSH loader's module table. Bundling a second
    // copy would give the page two React instances and break hooks.
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    logLevel: 'warning',
  });

  const bundled = result.outputFiles[0].text;

  // The IIFE assigns `var __avatarLabModule = (() => {...})()`. Rewrite that
  // into the loader registration DSH expects, and route React through the
  // loader's `require` so the shared instance is used.
  const registration = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(PLUGIN_ID)},
  factory: (require) => {
    var React = require("react");
    ${bundled.replace(/var __avatarLabModule\s*=\s*/, 'var __avatarLabModule = ')}
    var mod = __avatarLabModule && __avatarLabModule.default ? __avatarLabModule.default : __avatarLabModule;
    return mod && mod.default ? mod.default : mod;
  },
});
`;

  await writeFile(resolve(OUT_DIR, 'client.js'), registration, 'utf8');

  // ── 2. Emit the package manifest for `dsh plugin add link:<dir>` ──────
  const manifest = {
    name: PLUGIN_ID,
    version: '0.1.0',
    private: true,
    type: 'module',
    description: 'Personal Assistant Avatar Lab — procedural AI avatar engine and interactive lab page.',
    main: 'index.js',
    exports: {
      '.': './index.js',
      './client': './client.js',
      './package.json': './package.json',
    },
    dsh: {
      // `bundle.patch` is what makes DSH apply this package as a profile
      // layer. Without it the package installs as a plain dependency and the
      // plugin never appears in the browser roster.
      bundle: {
        patch: './cordis.patch.yml',
      },
      client: {
        platform: 'web',
        inject: [],
      },
    },
    files: ['index.js', 'client.js', 'cordis.patch.yml'],
    license: 'MIT',
  };
  await writeFile(resolve(OUT_DIR, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  // ── 3. A no-op host half ──────────────────────────────────────────────
  // The bundle is declared dual-face (`dsh.client`); DSH scans loader rows and
  // needs a resolvable main entry. The Lab is purely browser-side, so the host
  // half provides nothing.
  await writeFile(
    resolve(OUT_DIR, 'index.js'),
    `/**
 * Host half of the Avatar Lab plugin.
 *
 * The Avatar Lab is entirely browser-side: all animation runs in the client
 * half (./client.js) against the Canvas 2D renderer. This module exists only
 * because DSH composes plugins as dual-face packages with a resolvable main
 * entry, and it deliberately registers nothing on the host.
 */
export const name = ${JSON.stringify(PLUGIN_ID)};

export function apply() {
  // Intentionally empty: no host services, no routes, no tools.
}
`,
    'utf8',
  );

  await cp(resolve(ROOT, 'src/plugin/cordis.patch.yml'), resolve(OUT_DIR, 'cordis.patch.yml')).catch(() => {});

  const size = (await readFile(resolve(OUT_DIR, 'client.js'))).length;
  console.log(`avatar-lab plugin built`);
  console.log(`  dist/plugin/client.js   ${(size / 1024).toFixed(1)} kB`);
  console.log(`  dist/plugin/index.js`);
  console.log(`  dist/plugin/package.json`);
}

main().catch((err) => {
  console.error('build-plugin failed:', err);
  process.exit(1);
});
