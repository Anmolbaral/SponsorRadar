import { access, cp, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");

await copyDirectoryIfPresent(
  path.join(root, ".next", "static"),
  path.join(standalone, ".next", "static")
);
await copyDirectoryIfPresent(
  path.join(root, "public"),
  path.join(standalone, "public")
);

async function copyDirectoryIfPresent(source, destination) {
  try {
    await access(source);
  } catch {
    return;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}
