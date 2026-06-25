// functions/api/cancel-mint.js — PIEVIENOTS RETRY
import { ethers } from 'ethers';
import { requireAuth } from "../_lib/auth.js";
import { checkRateLimit } from "../_lib/rateLimit.js";
import { clearPendingTrack } from "./cleanup-pending.js";
import { getRobotSigner } from "../_lib/robot.js";

const WALLET_NFT_ABI = [
  "function cancelMint(address wallet) external",
  "function getPendingMint(address wallet) external view returns (tuple(bytes32 imageHash, bytes32 videoHash, bytes32 contentHash, uint256 nonce, uint256 deposit, bool exists))"
];

const MAX_RETRIES = 5;

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const user = await requireAuth(request, env);
    if (user instanceof Response) return user;
    if (!user || !user.address) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }

    const rateKey = `cancel:${user.address.toLowerCase()}`;
    if (!(await checkRateLimit({ key: rateKey, limit: 3, windowMs: 60000 }, env))) {
      return new Response(JSON.stringify({ success: false, error: 'Too many requests' }), { status: 429, headers: { "Content-Type": "application/json" } });
    }

    let body;
    try { body = await request.json(); } catch (e) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid JSON' }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    const { wallet } = body;
    if (!wallet || !ethers.isAddress(wallet)) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid wallet address' }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    if (user.address.toLowerCase() !== wallet.toLowerCase()) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized wallet' }), { status: 403, headers: { "Content-Type": "application/json" } });
    }

    const CONTRACT_ADDRESS = env.CONTRACT_ADDRESS;
    const ROBOT_PRIVATE_KEY = env.ROBOT_PRIVATE_KEY;
    const ALCHEMY_RPC_URL = env.ALCHEMY_RPC_URL;

    if (!CONTRACT_ADDRESS || !ROBOT_PRIVATE_KEY || !ALCHEMY_RPC_URL) {
      return new Response(JSON.stringify({ success: false, error: 'Server configuration incomplete' }), { status: 500, headers: { "Content-Type": "application/json" } });
    }

    const provider = new ethers.JsonRpcProvider(ALCHEMY_RPC_URL);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, WALLET_NFT_ABI, provider);
    
    let pendingMint;
    try { pendingMint = await contract.getPendingMint(wallet); } catch (err) {
      return new Response(JSON.stringify({ success: false, error: 'Cannot read pending mint: ' + err.message }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    if (!pendingMint || !pendingMint.exists) {
      return new Response(JSON.stringify({ success: false, error: 'No pending mint found for this wallet' }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    console.log('🔍 CANCEL MINT DEBUG:');
    console.log('  User wallet:', wallet);
    console.log('  Pending deposit (ETH):', ethers.formatEther(pendingMint.deposit));

    const robotSigner = getRobotSigner(env, provider);
    const contractWithSigner = new ethers.Contract(CONTRACT_ADDRESS, WALLET_NFT_ABI, robotSigner);
    
    // 🚀 RETRY — līdz 5 mēģinājumiem ar pieaugošu pauzi
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`🤖 Cancel robot: calling cancelMint (attempt ${attempt}/${MAX_RETRIES})...`);
        const cancelTx = await contractWithSigner.cancelMint(wallet);
        console.log(`🤖 Cancel tx sent! Hash: ${cancelTx.hash}`);
        clearPendingTrack(wallet);
        
        return new Response(JSON.stringify({ success: true, message: 'Transaction submitted successfully', txHash: cancelTx.hash, wallet: wallet, refundAmount: pendingMint.deposit.toString(), refundEth: ethers.formatEther(pendingMint.deposit) }), { status: 200, headers: { "Content-Type": "application/json" } });
      } catch (cancelError) {
        lastError = cancelError;
        const isNonceError = cancelError.message?.includes('nonce') || cancelError.code === 'NONCE_EXPIRED' || cancelError.code === 'REPLACEMENT_UNDERPRICED';
        
        if (isNonceError && attempt < MAX_RETRIES) {
          console.warn(`⚠️ Nonce conflict, retrying (attempt ${attempt}/${MAX_RETRIES})...`);
          await new Promise(r => setTimeout(r, 1000 * attempt)); // 1s, 2s, 3s, 4s pauze
          robotSigner.reset(); // Atiestata nonce
        } else {
          throw cancelError; // Nav nonce kļūda vai beigušies mēģinājumi
        }
      }
    }
    
    console.error('❌ Cancel failed after ' + MAX_RETRIES + ' attempts:', lastError.message);
    return new Response(JSON.stringify({ success: false, error: 'Cancel failed: ' + lastError.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    
  } catch (error) {
    console.error('💥 Cancel mint error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Server error: ' + error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
