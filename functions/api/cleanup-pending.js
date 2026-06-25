// ============================================================
// CLEANUP ROBOT — Skenē līgumu, atceļ pending mintus > 30 min
// Izmanto vienoto NonceManager caur getRobotSigner
// Eksportē executePendingCleanup() priekš cron-runner.js
// Izmanto līguma timestamp — nav atkarīgs no servera atmiņas
// ============================================================
import { ethers } from 'ethers';
import { getRobotSigner } from "../_lib/robot.js";

// 🛠️ LABOTS ABI: Pievienoti precīzi struktūras lauku nosaukumi 1:1 ar Solidity struct,
// lai Ethers.js pareizi atkodētu objektu, un p.exists / p.timestamp nebūtu undefined.
const WALLET_NFT_ABI = [
  "function getAllPendingAddresses() view returns (address[])",
  "function getPendingMint(address) view returns (tuple(bytes32 imageHash, bytes32 videoHash, bytes32 contentHash, uint256 nonce, uint256 deposit, uint64 timestamp, uint64 arrayIndex, bool exists))",
  "function cancelMint(address) external"
];

export function trackPendingMint(walletAddr) {
  // Saglabāts atpakaļsaderībai — vairs netiek izmantots cleanup loģikā
}

export function clearPendingTrack(walletAddr) {
  // Saglabāts atpakaļsaderībai
}

export async function executePendingCleanup(env) {
  const { CONTRACT_ADDRESS, ROBOT_PRIVATE_KEY, ALCHEMY_RPC_URL } = env;
  const MAX_MIN = parseInt(env.MAX_PENDING_MIN || '30');

  if (!CONTRACT_ADDRESS || !ROBOT_PRIVATE_KEY || !ALCHEMY_RPC_URL) {
    console.error("❌ Cleanup kļūda: Trūkst nepieciešamo vides mainīgo (env).");
    return { checked: 0, cancelled: 0, errors: 0 };
  }

  const provider = new ethers.JsonRpcProvider(ALCHEMY_RPC_URL);
  const robotSigner = getRobotSigner(env, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, WALLET_NFT_ABI, robotSigner);

  let allAddresses;
  try {
    allAddresses = await contract.getAllPendingAddresses();
  } catch (e) {
    console.error("❌ Neizdevās ielasīt pending adreses no viedā līguma:", e.message);
    return { checked: 0, cancelled: 0, errors: 1 };
  }

  console.log(`🧹 Cleanup: checking ${allAddresses.length} on-chain pending mints...`);

  const results = { checked: allAddresses.length, cancelled: 0, errors: 0 };
  const nowSec = Math.floor(Date.now() / 1000);

  for (const addr of allAddresses) {
    try {
      const p = await contract.getPendingMint(addr);
      
      // Tagad p.exists un p.timestamp atgriezīs korektas vērtības
      if (!p || !p.exists) {
        continue;
      }

      const elapsedSec = nowSec - Number(p.timestamp);
      const elapsedMin = (elapsedSec / 60).toFixed(1);

      if (elapsedSec > MAX_MIN * 60) {
        console.log(`🧹 Atceļam un atgriežam līdzekļus: ${addr} (gaida jau ${elapsedMin} min)...`);
        
        // cancelMint tiks izsaukts caur globālo NonceManager (bez liekiem gāzes limitiem)
        const tx = await contract.cancelMint(addr);
        console.log(`🧹 Atcelšanas transakcija nosūtīta! Hash: ${tx.hash}`);
        
        await tx.wait();
        results.cancelled++;
        console.log(`🧹 ✅ Refunded ${ethers.formatEther(p.deposit)} ETH to ${addr.substring(0, 10)}...`);
      } else {
        console.log(`  ⏳ ${addr.substring(0, 10)}... gaida rindā (${elapsedMin} min / limits ${MAX_MIN} min)`);
      }
    } catch (e) {
      console.error(`❌ Kļūda apstrādājot adresi ${addr}:`, e.message);
      results.errors++;
    }
  }

  console.log(`🧹 Cleanup done: ${results.checked} checked, ${results.cancelled} cancelled, ${results.errors} errors`);
  return results;
}
