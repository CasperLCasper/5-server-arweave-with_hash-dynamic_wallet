// ============================================================
// CLEANUP ROBOT — Skenē līgumu, atceļ pending mintus > 30 min
// Izmanto vienoto NonceManager caur getRobotSigner
// Eksportē executePendingCleanup() priekš cron-runner.js
// Izsauc: GET /api/cleanup-pending
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

export async function executePendingCleanup(env) {
  const { CONTRACT_ADDRESS, ROBOT_PRIVATE_KEY, ALCHEMY_RPC_URL } = env;
  const MAX_MIN = parseInt(env.MAX_PENDING_MIN || '30');

  if (!CONTRACT_ADDRESS || !ROBOT_PRIVATE_KEY || !ALCHEMY_RPC_URL) {
    return { checked: 0, cancelled: 0, errors: 0 };
  }

  const provider = new ethers.JsonRpcProvider(ALCHEMY_RPC_URL);
  const robotSigner = getRobotSigner(env, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, WALLET_NFT_ABI, robotSigner);

  let allAddresses;
  try {
    allAddresses = await contract.getAllPendingAddresses();
  } catch (e) {
    return { checked: 0, cancelled: 0, errors: 1 };
  }

  console.log(`🧹 Cleanup: checking ${allAddresses.length} on-chain pending mints...`);

  const results = { checked: allAddresses.length, cancelled: 0, errors: 0 };

  for (const addr of allAddresses) {
    try {
      const p = await contract.getPendingMint(addr);
      
      if (!p.exists) {
        pendingSince.delete(addr);
        continue;
      }

      const startTime = pendingSince.get(addr) || Date.now();
      const elapsed = Date.now() - startTime;
      const elapsedMin = (elapsed / 60000).toFixed(1);

      if (elapsed > MAX_MIN * 60000) {
        // 🚀 BEZ gasLimit — izmanto estimateGas
        const tx = await contract.cancelMint(addr);
        await tx.wait();
        pendingSince.delete(addr);
        results.cancelled++;
        console.log(`🧹 Refunded ${ethers.formatEther(p.deposit)} ETH to ${addr.substring(0,10)}... (${elapsedMin} min)`);
      }
    } catch (e) {
      results.errors++;
    }
  }

  console.log(`🧹 Cleanup done: ${results.checked} checked, ${results.cancelled} cancelled, ${results.errors} errors`);
  return results;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  
  const authHeader = request.headers.get('Authorization');
  if (!env.CLEANUP_API_KEY || authHeader !== `Bearer ${env.CLEANUP_API_KEY}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  
  const results = await executePendingCleanup(env);
  
  return new Response(JSON.stringify({ success: true, timestamp: new Date().toISOString(), ...results }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
