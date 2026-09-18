import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = process.cwd();
const unit = "contracts/ScanArcCCTPBridgeV2.sol";
const name = "ScanArcCCTPBridgeV2";
const source = fs.readFileSync(path.join(root, unit), "utf8");
const input = {
  language: "Solidity",
  sources: { [unit]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "metadata"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
for (const item of output.errors ?? []) console[item.severity === "error" ? "error" : "warn"](item.formattedMessage);
if ((output.errors ?? []).some((e) => e.severity === "error")) process.exit(1);

const artifact = output.contracts?.[unit]?.[name];
if (!artifact?.evm?.bytecode?.object) throw new Error(`Missing ${name} artifact`);

fs.mkdirSync(path.join(root, "lib"), { recursive: true });
fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });

const generated = `// AUTO-GENERATED FROM ${unit}. Do not edit.\nexport const cctpBridgeV2Abi = ${JSON.stringify(artifact.abi, null, 2)} as const;\nexport const cctpBridgeV2Bytecode = ${JSON.stringify(`0x${artifact.evm.bytecode.object}`)} as \`0x\${string}\`;\nexport const cctpBridgeV2CompilerVersion = ${JSON.stringify(solc.version())} as const;\n`;

fs.writeFileSync(path.join(root, "lib", "scanarc-cctp-bridge-v2.generated.ts"), generated);
fs.writeFileSync(
  path.join(root, "lib", "scanarc-cctp-bridge-v2-verification.generated.ts"),
  `// AUTO-GENERATED. Do not edit.\nexport const cctpBridgeV2StandardJsonInput = ${JSON.stringify(JSON.stringify(input))} as const;\n`,
);
fs.writeFileSync(path.join(root, "artifacts", `${name}.abi.json`), JSON.stringify(artifact.abi, null, 2));
fs.writeFileSync(path.join(root, "artifacts", `${name}.bin`), artifact.evm.bytecode.object);
fs.writeFileSync(path.join(root, "artifacts", `${name}.standard-input.json`), JSON.stringify(input, null, 2));
console.log(`${name}: ${artifact.evm.bytecode.object.length / 2} creation bytes; ${solc.version()}`);
