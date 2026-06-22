// ============================================================
// CLEANUP ROBOT — Skenē līgumu, atceļ pending mintus > 30 min
// Izsauc: GET /api/cleanup-pending
// ============================================================
import { ethers } from 'ethers';

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

export async function onRequestGet(context) {
  const { env } = context;
  const { CONTRACT_ADDRESS, ROBOT_PRIVATE_KEY, ALCHEMY_RPC_URL } = env;
  const MAX_MIN = parseInt(env.MAX_PENDING_MIN || '30');

  if (!CONTRACT_ADDRESS || !ROBOT_PRIVATE_KEY || !ALCHEMY_RPC_URL) {
    return new Response(JSON.stringify({ error: 'Config missing' }), { status: 500 });
  }

  const provider = new ethers.JsonRpcProvider(ALCHEMY_RPC_URL);
  const robot = new ethers.Wallet(ROBOT_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, WALLET_NFT_ABI, robot);

  let allAddresses;
  try {
    allAddresses = await contract.getAllPendingAddresses();
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: 'Cannot read addresses: ' + e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
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
        const tx = await contract.cancelMint(addr);
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
      results.errors++;
      results.details.push({ wallet: addr.substring(0, 10), status: 'error', error: e.message?.substring(0, 60) });
    }
  }

  console.log(`🧹 Cleanup done: ${results.checked} checked, ${results.cancelled} cancelled, ${results.errors} errors`);

  return new Response(JSON.stringify({ success: true, timestamp: new Date().toISOString(), ...results }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
