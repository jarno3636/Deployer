import { readFile } from "node:fs/promises";
const abi = JSON.parse(await readFile(new URL("../artifacts/ScanArcRouterV3.abi.json", import.meta.url), "utf8"));
const bytecode = (await readFile(new URL("../artifacts/ScanArcRouterV3.bin", import.meta.url), "utf8")).trim();
if (!Array.isArray(abi) || abi.length < 15) throw new Error("ScanArcRouterV3 ABI is missing or incomplete.");
if (bytecode.length < 1000) throw new Error("ScanArcRouterV3 creation bytecode is missing or too short.");
console.log("ScanArcRouterV3 artifacts look complete.");
