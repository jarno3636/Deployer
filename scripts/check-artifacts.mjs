import { readFile } from "node:fs/promises";
const abi = JSON.parse(await readFile(new URL("../artifacts/ScanArcRouter.abi.json", import.meta.url), "utf8"));
const bytecode = (await readFile(new URL("../artifacts/ScanArcRouter.bin", import.meta.url), "utf8")).trim();
if (!Array.isArray(abi) || abi.length < 10) throw new Error("Router ABI is missing or incomplete.");
if (bytecode.length < 1000) throw new Error("Router creation bytecode is missing or too short.");
console.log("ScanArc router artifacts look complete.");
