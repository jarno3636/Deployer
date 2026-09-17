import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = process.cwd();
const sourcePath = path.join(root, "contracts", "ScanArcCCTPBridgeV1.sol");
const source = fs.readFileSync(sourcePath, "utf8");
const input = {
  language: "Solidity",
  sources: { "ScanArcCCTPBridgeV1.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
  }
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors ?? []).filter((e) => e.severity === "error");
if (errors.length) { console.error(errors.map((e) => e.formattedMessage).join("\n")); process.exit(1); }
const artifact = output.contracts["ScanArcCCTPBridgeV1.sol"].ScanArcCCTPBridgeV1;
fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
fs.writeFileSync(path.join(root, "artifacts", "ScanArcCCTPBridgeV1.abi.json"), JSON.stringify(artifact.abi, null, 2) + "\n");
fs.writeFileSync(path.join(root, "artifacts", "ScanArcCCTPBridgeV1.bin"), artifact.evm.bytecode.object + "\n");
console.log("Compiled ScanArcCCTPBridgeV1 with", solc.version());
