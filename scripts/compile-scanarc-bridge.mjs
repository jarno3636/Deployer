import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = process.cwd();
const contracts = [
  { unit: "contracts/ScanArcBridgeRegistryV1.sol", name: "ScanArcBridgeRegistryV1", prefix: "bridgeRegistry" },
  { unit: "contracts/ScanArcCCTPBridgeV1.sol", name: "ScanArcCCTPBridgeV1", prefix: "cctpBridge" },
];

fs.mkdirSync(path.join(root, "lib"), { recursive: true });
fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });

for (const { unit, name, prefix } of contracts) {
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
  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) process.exit(1);
  const artifact = output.contracts?.[unit]?.[name];
  if (!artifact?.evm?.bytecode?.object) throw new Error(`Missing ${name} artifact`);

  const generated = `// AUTO-GENERATED FROM ${unit}. Do not edit.\nexport const ${prefix}Abi = ${JSON.stringify(artifact.abi, null, 2)} as const;\nexport const ${prefix}Bytecode = ${JSON.stringify(`0x${artifact.evm.bytecode.object}`)} as \`0x\${string}\`;\nexport const ${prefix}CompilerVersion = ${JSON.stringify(solc.version())} as const;\n`;
  fs.writeFileSync(path.join(root, "lib", `${prefix === "bridgeRegistry" ? "scanarc-bridge" : "scanarc-cctp-bridge"}.generated.ts`), generated);
  fs.writeFileSync(path.join(root, "artifacts", `${name}.abi.json`), JSON.stringify(artifact.abi, null, 2));
  fs.writeFileSync(path.join(root, "artifacts", `${name}.bin`), artifact.evm.bytecode.object);
  fs.writeFileSync(path.join(root, "artifacts", `${name}.standard-input.json`), JSON.stringify(input, null, 2));

  if (prefix === "bridgeRegistry") {
    fs.writeFileSync(path.join(root, "lib", "scanarc-bridge-verification.generated.ts"), `// AUTO-GENERATED. Do not edit.\nexport const bridgeStandardJsonInput = ${JSON.stringify(JSON.stringify(input))} as const;\n`);
  } else {
    fs.writeFileSync(path.join(root, "lib", "scanarc-cctp-bridge-verification.generated.ts"), `// AUTO-GENERATED. Do not edit.\nexport const cctpBridgeStandardJsonInput = ${JSON.stringify(JSON.stringify(input))} as const;\n`);
  }
  console.log(`${name}: ${artifact.evm.bytecode.object.length / 2} creation bytes; ${solc.version()}`);
}
