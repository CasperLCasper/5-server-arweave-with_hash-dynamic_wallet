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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function validateWallet(body) {
  const { wallet } = body || {};
  if (!wallet || !ethers.isAddress(wallet)) {
    return { error: jsonResponse({ success: false, error: 'Invalid wallet address' }, 400) };
  }
  return { wallet };
}

function validateUserWallet(user, wallet) {
  if (user.address.toLowerCase() !== wallet.toLowerCase()) {
    return { error: jsonResponse({ success: false, error: 'Unauthorized wallet' }, 403) };
  }
  return {};
}

async function fetchPendingMint(contract, wallet) {
  try {
    const pendingMint = await contract.getPendingMint(wallet);
    return { pendingMint };
  } catch (err) {
    return { error: jsonResponse({ success: false, error: 'Cannot read pending mint: ' + err.message }, 400) };
  }
}

async function attemptCancel(contractWithSigner, wallet, pendingMint) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`🤖 Cancel robot: calling cancelMint (attempt ${attempt}/${MAX_RETRIES})...`);
      const cancelTx = await contractWithSigner.cancelMint(wallet);
      console.log(`🤖 Cancel tx sent! Hash: ${cancelTx.hash}`);
      clearPendingTrack(wallet);
      
      return {
        success: true,
        txHash: cancelTx.hash,
        refundAmount: pendingMint.deposit.toString(),
        refundEth: ethers.formatEther(pendingMint.deposit)
      };
    } catch (cancelError) {
      lastError = cancelError;
      const isNonceError = cancelError.message?.includes('nonce') || 
                          cancelError.code === 'NONCE_EXPIRED' || 
                          cancelError.code === 'REPLACEMENT_UNDERPRICED';
      
      if (isNonceError && attempt < MAX_RETRIES) {
        console.warn(`⚠️ Nonce conflict, retrying (attempt ${attempt}/${MAX_RETRIES})...`);
        await new Promise(r => setTimeout(r, 1000 * attempt));
      } else {
        throw cancelError;
      }
    }
  }
  
  throw lastError;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // Auth validācija
    const user = await requireAuth(request, env);
    if (user instanceof Response) return user;
    if (!user?.address) {
      return jsonResponse({ success: false, error: "Unauthorized" }, 401);
    }

    // Rate limiting
    const rateKey = `cancel:${user.address.toLowerCase()}`;
    if (!(await checkRateLimit({ key: rateKey, limit: 3, windowMs: 60000 }, env))) {
      return jsonResponse({ success: false, error: 'Too many requests' }, 429);
    }

    // Request body validācija
    let body;
    try { 
      body = await request.json(); 
    } catch (e) {
      return jsonResponse({ success: false, error: 'Invalid JSON' }, 400);
    }

    const { wallet, error: walletError } = validateWallet(body);
    if (walletError) return walletError;

    const { error: userError } = validateUserWallet(user, wallet);
    if (userError) return userError;

    // Env validācija
    const { CONTRACT_ADDRESS, ROBOT_PRIVATE_KEY, ALCHEMY_RPC_URL } = env;
    if (!CONTRACT_ADDRESS || !ROBOT_PRIVATE_KEY || !ALCHEMY_RPC_URL) {
      return jsonResponse({ success: false, error: 'Server configuration incomplete' }, 500);
    }

    // Līguma inicializācija
    const provider = new ethers.JsonRpcProvider(ALCHEMY_RPC_URL);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, WALLET_NFT_ABI, provider);
    
    const { pendingMint, error: pendingError } = await fetchPendingMint(contract, wallet);
    if (pendingError) return pendingError;

    if (!pendingMint?.exists) {
      return jsonResponse({ success: false, error: 'No pending mint found for this wallet' }, 400);
    }

    console.log('🔍 CANCEL MINT DEBUG:');
    console.log('  User wallet:', wallet);
    console.log('  Pending deposit (ETH):', ethers.formatEther(pendingMint.deposit));

    // Cancel izpilde ar retry
    const contractWithSigner = new ethers.Contract(CONTRACT_ADDRESS, WALLET_NFT_ABI, getRobotSigner(env, provider));
    
    const result = await attemptCancel(contractWithSigner, wallet, pendingMint);
    
    return jsonResponse({ 
      success: true, 
      message: 'Transaction submitted successfully',
      wallet,
      ...result
    });
    
  } catch (error) {
    console.error('💥 Cancel mint error:', error);
    return jsonResponse({ success: false, error: 'Server error: ' + error.message }, 500);
  }
}
