import process from "node:process";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const priorTurns = (input.match(/^### /gm) || []).length;
const status = priorTurns >= 2 ? "done" : "continue";
const name = process.argv[2] || process.env.BRIDGE_AGENT_NAME || "Mock";
const response = {
  status,
  message: `${name} inspected the shared project. Prior turns: ${priorTurns}.`,
};
process.stdout.write(`<<<BRIDGE_RESPONSE>>>\n${JSON.stringify(response)}\n<<<END_BRIDGE_RESPONSE>>>\n`);
