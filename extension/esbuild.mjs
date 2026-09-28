import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** Bundle 1 — the extension host. */
const extensionBundle = {
  entryPoints: ["src/extension.ts"],
  outfile: "out/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** Bundle 2 — the webview UI. */
const webviewBundle = {
  entryPoints: ["webview/main.tsx"],
  outfile: "media/webview.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  jsx: "automatic",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": production ? '"production"' : '"development"',
  },
};

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extensionBundle),
    esbuild.context(webviewBundle),
  ]);
  await Promise.all(contexts.map((context) => context.watch()));
  console.log("[esbuild] watching for changes...");
} else {
  await Promise.all([
    esbuild.build(extensionBundle),
    esbuild.build(webviewBundle),
  ]);
  console.log("[esbuild] build complete");
}
