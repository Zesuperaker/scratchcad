// Where this package's files are, whether the server runs from src/ (with
// Node's type stripping) or from the compiled dist/server/.
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function packageRoot(here = HERE): string {
  return path.resolve(here, here.endsWith(path.join("dist", "server")) ? "../.." : "..");
}
