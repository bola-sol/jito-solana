/** Checks that the committed `dist/` is what this source tree builds, by rebuilding it into a
 *  scratch directory and comparing file by file. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const committed = join(root, "dist");
const rebuilt = join(root, ".dist-verify");

function hashTree(dir) {
  const files = new Map();
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else {
        // Normalised to forward slashes so the report reads the same on
        // Windows as it does anywhere else.
        const name = relative(dir, path).split(sep).join("/");
        files.set(name, createHash("sha256").update(readFileSync(path)).digest("hex"));
      }
    }
  };
  visit(dir);
  return files;
}

if (!existsSync(committed)) {
  console.error("dist/ is missing. Run `npm run build` first.");
  process.exit(1);
}

// Invoked through node rather than through npx, which needs a shell on Windows
// and resolves differently depending on what else is installed.
const vite = join(root, "node_modules", "vite", "bin", "vite.js");
if (!existsSync(vite)) {
  console.error("vite is not installed. Run `npm install` first.");
  process.exit(1);
}

rmSync(rebuilt, { recursive: true, force: true });
try {
  execFileSync(process.execPath, [vite, "build", "--outDir", rebuilt, "--emptyOutDir"], {
    cwd: root,
    stdio: "inherit",
  });

  const expected = hashTree(committed);
  const actual = hashTree(rebuilt);
  const names = [...new Set([...expected.keys(), ...actual.keys()])].sort();

  const differences = names.flatMap((name) => {
    const before = expected.get(name);
    const after = actual.get(name);
    if (before === after) return [];
    if (before === undefined) return [`  only in the rebuild:  ${name}`];
    if (after === undefined) return [`  only in dist/:        ${name}`];
    return [`  contents differ:      ${name}`];
  });

  if (differences.length > 0) {
    console.error(`\ndist/ does not match a fresh build of this source:\n`);
    console.error(differences.join("\n"));
    console.error(`\nRebuild with \`npm run build\` and commit the result.\n`);
    process.exit(1);
  }

  console.log(`\ndist/ matches a fresh build: ${names.length} files identical.\n`);
} finally {
  rmSync(rebuilt, { recursive: true, force: true });
}
