// ============================================================
// CLEANUP ROBOT — Skenē līgumu, atceļ pending mintus > 30 min
// Izmanto vienoto NonceManager caur getRobotSigner
// Eksportē executePendingCleanup() priekš cron-runner.js
// HTTP API aizsargāts ar CLEANUP_API_KEY
// ============================================================
import { ethers } from 'ethers';
import { getRobotSigner } from "../_lib/robot.js";

const WALLET_NFT_ABI = [
  "function getAllPendingAddresses() view returns (address[])",
  "function getPendingMint(address) view returns (tuple(bytes32,bytes32,bytes32,uint256,uint256,uint64,uint64,bool))",
  "function cancelMint(address) external",
];

const pendingSince = new Map();

export function trackPendingMint(walletAddr) {
  if (!pendingSince.has(walletAddr)) {
    pendingSince.set(walletAddr, Date.now());
  }
}

export function clearPendingTrack(walletAddr) {
  pendingSince.delete(walletAddr);
}

// 🚀 Galvenā funkcija — izmanto gan cron-runner.js, gan HTTP API
export async function executePendingCleanup(env) {
  const { CONTRACT_ADDRESS, ROBOT_PRIVATE_KEY, ALCHEMY_RPC_URL } = env;
  const MAX_MIN = Number.parseInt(env.MAX_PENDING_MIN || '30', 10);

  if (!CONTRACT_ADDRESS || !ROBOT_PRIVATE_KEY || !ALCHEMY_RPC_URL) {
    return { checked: 0, cancelled: 0, errors: 0, details: [] };
  }

  const provider = new ethers.JsonRpcProvider(ALCHEMY_RPC_URL);
  
  // 🚀 VIENOTAIS NonceManager — nekādu nonce konfliktu ar citiem endpointiem!
  const robotSigner = getRobotSigner(env, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, WALLET_NFT_ABI, robotSigner);

  let allAddresses;
  try {
    allAddresses = await contract.getAllPendingAddresses();
  } catch (e) {
    return { checked: 0, cancelled: 0, errors: 1, details: [{ error: e.message?.substring(0, 60) }] };
  }

  console.log(`🧹 Cleanup: checking ${allAddresses.length} on-chain pending mints...`);

  const results = { checked: allAddresses.length, cancelled: 0, errors: 0, details: [] };

  for (const addr of allAddresses) {
    try {
      const p = await contract.getPendingMint(addr);
      
      if (!p.exists) {
        pendingSince.delete(addr);
        results.details.push({ wallet: addr.substring(0, 10), status: 'already_cleared' });
        continue;
      }

      const startTime = pendingSince.get(addr) || Date.now();
      const elapsed = Date.now() - startTime;
      const elapsedMin = (elapsed / 60000).toFixed(1);

      if (elapsed > MAX_MIN * 60000) {
        // 🚀 Fiksēts gasLimit — izlaiž estimateGas
        const tx = await contract.cancelMint(addr, { gasLimit: 120000 });
        await tx.wait();
        pendingSince.delete(addr);
        results.cancelled++;
        results.details.push({
          wallet: addr.substring(0, 10),
          status: 'cancelled',
          txHash: tx.hash.substring(0, 20),
          elapsedMin,
          refundEth: ethers.formatEther(p.deposit)
        });
        console.log(`🧹 Refunded ${ethers.formatEther(p.deposit)} ETH to ${addr.substring(0,10)}...`);
      } else {
        results.details.push({ wallet: addr.substring(0, 10), status: 'waiting', elapsedMin });
      }
    } catch (e) {
      // Katrs lietotājs atsevišķi — viena kļūda neaptur visu cilpu
      results.errors++;
      results.details.push({ wallet: addr.substring(0, 10), status: 'error', error: e.message?.substring(0, 60) });
    }
  }

  console.log(`🧹 Cleanup done: ${results.checked} checked, ${results.cancelled} cancelled, ${results.errors} errors`);
  return results;
}

// 🔒 HTTP API — aizsargāts ar CLEANUP_API_KEY
export async function onRequestGet(context) {
  const { env, request } = context;
  
  const authHeader = request.headers.get('Authorization');
  if (!env.CLEANUP_API_KEY || authHeader !== `Bearer ${env.CLEANUP_API_KEY}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }
  
  const results = await executePendingCleanup(env);
  
  return new Response(JSON.stringify({ success: true, timestamp: new Date().toISOString(), ...results }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
