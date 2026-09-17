import { getAddress, isAddress } from "viem";

export const ARC_CHAIN_ID = 5042;
export const ARCFUN_FACTORY = getAddress("0xBBf81Fd835B471C86d094eAaD35BB10068a987f8");

function textAddress(value: unknown): string | null {
  if (typeof value === "string" && isAddress(value)) return getAddress(value);
  if (value && typeof value === "object") {
    const candidate = (value as any).hash ?? (value as any).address_hash ?? (value as any).address;
    if (typeof candidate === "string" && isAddress(candidate)) return getAddress(candidate);
  }
  return null;
}

function textHash(value: unknown): `0x${string}` | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? value as `0x${string}` : null;
}

async function proGet(path: string, key: string) {
  const separator = path.includes("?") ? "&" : "?";
  const url = `https://api.blockscout.com/${ARC_CHAIN_ID}/api/v2/${path}${separator}apikey=${encodeURIComponent(key)}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Blockscout REST lookup failed (${response.status}).`);
  return response.json();
}

async function legacyCreation(addresses: string[], key: string) {
  const params = new URLSearchParams({
    chain_id: String(ARC_CHAIN_ID),
    module: "contract",
    action: "getcontractcreation",
    contractaddresses: addresses.join(","),
    apikey: key,
  });
  const response = await fetch(`https://api.blockscout.com/v2/api?${params}`, { cache: "no-store" });
  if (!response.ok) return [] as any[];
  const json = await response.json();
  return Array.isArray(json?.result) ? json.result : [];
}

async function creationInfo(address: string, key: string) {
  let creator: string | null = null;
  let txHash: `0x${string}` | null = null;
  try {
    const info = await proGet(`addresses/${address}`, key);
    creator = textAddress(info?.creator_address_hash ?? info?.creator_address);
    txHash = textHash(info?.creation_transaction_hash ?? info?.creation_tx_hash);
  } catch {}
  return { creator, txHash };
}

async function transactionTo(hash: string, key: string) {
  try {
    const tx = await proGet(`transactions/${hash}`, key);
    return {
      to: textAddress(tx?.to),
      status: typeof tx?.status === "string" ? tx.status : null,
    };
  } catch {
    const response = await fetch(`https://api.blockscout.com/${ARC_CHAIN_ID}/json-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [hash] }),
      cache: "no-store",
    });
    const json = await response.json();
    return { to: textAddress(json?.result?.to), status: null };
  }
}

export type ProvenanceProof = {
  token: `0x${string}`;
  curve: `0x${string}`;
  creationTransaction: `0x${string}`;
  tokenCreator: string | null;
  curveCreator: string | null;
  launchTarget: string | null;
  proof: string;
};

export async function proveArcfunPair(tokenInput: string, curveInput: string, key: string): Promise<ProvenanceProof> {
  if (!isAddress(tokenInput) || !isAddress(curveInput)) throw new Error("Valid token and curve addresses are required.");
  const token = getAddress(tokenInput);
  const curve = getAddress(curveInput);
  if (token.toLowerCase() === curve.toLowerCase()) throw new Error("Token and curve must be different contracts.");

  let tokenInfo = await creationInfo(token, key);
  let curveInfo = await creationInfo(curve, key);

  if (!tokenInfo.txHash || !curveInfo.txHash) {
    const rows = await legacyCreation([token, curve], key);
    for (const row of rows) {
      const contract = textAddress(row?.contractAddress ?? row?.contract_address);
      if (!contract) continue;
      const info = {
        creator: textAddress(row?.contractCreator ?? row?.contract_creator),
        txHash: textHash(row?.txHash ?? row?.tx_hash),
      };
      if (contract.toLowerCase() === token.toLowerCase()) tokenInfo = { creator: tokenInfo.creator ?? info.creator, txHash: tokenInfo.txHash ?? info.txHash };
      if (contract.toLowerCase() === curve.toLowerCase()) curveInfo = { creator: curveInfo.creator ?? info.creator, txHash: curveInfo.txHash ?? info.txHash };
    }
  }

  if (!tokenInfo.txHash || !curveInfo.txHash) {
    throw new Error("Blockscout has not indexed creation provenance for both contracts yet.");
  }
  if (tokenInfo.txHash.toLowerCase() !== curveInfo.txHash.toLowerCase()) {
    throw new Error("Token and curve were not created in the same launch transaction.");
  }

  const launchTx = await transactionTo(tokenInfo.txHash, key);
  const factory = ARCFUN_FACTORY.toLowerCase();
  const launchTargetIsFactory = launchTx.to?.toLowerCase() === factory;
  const bothCreatedByFactory = tokenInfo.creator?.toLowerCase() === factory && curveInfo.creator?.toLowerCase() === factory;

  if (!launchTargetIsFactory && !bothCreatedByFactory) {
    throw new Error("Creation provenance does not lead back to the canonical Arcfun factory.");
  }

  return {
    token,
    curve,
    creationTransaction: tokenInfo.txHash,
    tokenCreator: tokenInfo.creator,
    curveCreator: curveInfo.creator,
    launchTarget: launchTx.to,
    proof: launchTargetIsFactory
      ? "Token and curve share one creation transaction sent to the canonical Arcfun factory."
      : "Token and curve share one creation transaction and both were created by the canonical Arcfun factory.",
  };
}
