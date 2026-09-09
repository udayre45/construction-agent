import "dotenv/config";
import { runAgent } from "./lib/agent";

const question =
  process.argv.slice(2).join(" ").trim() ||
  "What permit types exist in Seattle?";

runAgent(question)
  .then((answer) => {
    console.log(`\nQ: ${question}\n\nA: ${answer}`);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("FAILED:", message);
    process.exitCode = 1;
  });
