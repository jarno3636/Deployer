import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

const root = process.cwd();
const unit = 'contracts/ScanArcRouterV4.sol';
const name = 'ScanArcRouterV4';
const source = fs.readFileSync(path.join(root, unit), 'utf8');
const input = {
  language: 'Solidity',
  sources: { [unit]: { content: source } },
  settings: {
    viaIR: true,
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'metadata'] } },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
for (const item of output.errors ?? []) console[item.severity === 'error' ? 'error' : 'warn'](item.formattedMessage);
const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
if (errors.length) process.exit(1);
const artifact = output.contracts?.[unit]?.[name];
if (!artifact?.evm?.bytecode?.object) throw new Error('Missing ScanArcRouterV4 artifact');
fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
const generated = `// AUTO-GENERATED FROM contracts/ScanArcRouterV4.sol. Do not edit.\nexport const routerAbi = ${JSON.stringify(artifact.abi, null, 2)} as const;\nexport const routerBytecode = ${JSON.stringify(`0x${artifact.evm.bytecode.object}`)} as \`0x\${string}\`;\nexport const compilerVersion = ${JSON.stringify(solc.version())} as const;\n`;
fs.writeFileSync(path.join(root, 'lib', 'scanarc-router.generated.ts'), generated);
fs.writeFileSync(path.join(root, 'artifacts', 'ScanArcRouterV4.abi.json'), JSON.stringify(artifact.abi, null, 2));
fs.writeFileSync(path.join(root, 'artifacts', 'ScanArcRouterV4.bin'), artifact.evm.bytecode.object);
fs.writeFileSync(path.join(root, 'artifacts', 'ScanArcRouterV4.standard-input.json'), JSON.stringify(input, null, 2));
fs.writeFileSync(path.join(root, 'lib', 'scanarc-router-verification.generated.ts'), `// AUTO-GENERATED. Do not edit.\nexport const standardJsonInput = ${JSON.stringify(JSON.stringify(input))} as const;\n`);
console.log(`${name}: ${artifact.evm.bytecode.object.length / 2} creation bytes; ${solc.version()}`);
