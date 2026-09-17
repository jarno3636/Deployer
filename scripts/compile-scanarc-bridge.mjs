import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

const root = process.cwd();
const unit = 'contracts/ScanArcBridgeRegistryV1.sol';
const name = 'ScanArcBridgeRegistryV1';
const source = fs.readFileSync(path.join(root, unit), 'utf8');
const input = {
  language: 'Solidity',
  sources: { [unit]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'metadata'] } },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
for (const item of output.errors ?? []) console[item.severity === 'error' ? 'error' : 'warn'](item.formattedMessage);
const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
if (errors.length) process.exit(1);
const artifact = output.contracts?.[unit]?.[name];
if (!artifact?.evm?.bytecode?.object) throw new Error('Missing ScanArcBridgeRegistryV1 artifact');
fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
const generated = `// AUTO-GENERATED FROM contracts/ScanArcBridgeRegistryV1.sol. Do not edit.\nexport const bridgeRegistryAbi = ${JSON.stringify(artifact.abi, null, 2)} as const;\nexport const bridgeRegistryBytecode = ${JSON.stringify(`0x${artifact.evm.bytecode.object}`)} as \`0x\${string}\`;\nexport const bridgeCompilerVersion = ${JSON.stringify(solc.version())} as const;\n`;
fs.writeFileSync(path.join(root, 'lib', 'scanarc-bridge.generated.ts'), generated);
fs.writeFileSync(path.join(root, 'artifacts', 'ScanArcBridgeRegistryV1.abi.json'), JSON.stringify(artifact.abi, null, 2));
fs.writeFileSync(path.join(root, 'artifacts', 'ScanArcBridgeRegistryV1.bin'), artifact.evm.bytecode.object);
fs.writeFileSync(path.join(root, 'artifacts', 'ScanArcBridgeRegistryV1.standard-input.json'), JSON.stringify(input, null, 2));
fs.writeFileSync(path.join(root, 'lib', 'scanarc-bridge-verification.generated.ts'), `// AUTO-GENERATED. Do not edit.\nexport const bridgeStandardJsonInput = ${JSON.stringify(JSON.stringify(input))} as const;\n`);
console.log(`${name}: ${artifact.evm.bytecode.object.length / 2} creation bytes; ${solc.version()}`);
