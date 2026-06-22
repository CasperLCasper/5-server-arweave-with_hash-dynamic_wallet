// functions/api/finalize-mint.js
import { ethers } from 'ethers';
import { requireAuth } from "../_lib/auth.js";
import { checkRateLimit } from "../_lib/rateLimit.js";
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';
import { clearPendingTrack } from "./cleanup-pending.js";

const WALLET_NFT_ABI = [
  "function finalizeMint(address wallet, string calldata metadataUri, uint256 storageCostWei, bytes32 finalContentHash) external",
  "function getPendingMint(address wallet) external view returns (tuple(bytes32 imageHash, bytes32 videoHash, bytes32 contentHash, uint256 nonce, uint256 deposit, bool exists))",
  "function cancelMint(address wallet) external",
  "function mintPrice() public view returns (uint256)"
];

function parseMetadataUri(uri) {
  const trimmed = uri.trim();
  if (trimmed.startsWith('{')) return trimmed;
  if (trimmed.startsWith('Qm') || trimmed.startsWith('baf')) return `https://arweave.net/${trimmed}`;
  if (trimmed.startsWith('ipfs://')) return `https://arweave.net/${trimmed.substring(7)}`;
  if (trimmed.startsWith('ar://')) return `https://arweave.net/${trimmed.substring(5)}`;
  return trimmed;
}

async function executeRobotFinalize(provider, robotPrivateKey, contractAddress, { wallet, fullMetadataUri, storageCostWei, finalContentHash }) {
  const robotWallet = new ethers.Wallet(robotPrivateKey, provider);
  const robotAddress = await robotWallet.getAddress();
  const contractWithSigner = new ethers.Contract(contractAddress, WALLET_NFT_ABI, robotWallet);
  
  console.log(`🤖 Finalize robot (${robotAddress}): calling finalizeMint...`);
  
  const finalizeTx = await contractWithSigner.finalizeMint(
    wallet, fullMetadataUri, storageCostWei || 0, finalContentHash
  );
  console.log(`🤖 Finalize tx sent! Hash: ${finalizeTx.hash}`);
  await finalizeTx.wait();
  console.log('🤖 ✅ Mint finalized! NFT created.');
}

async function purchaseStorageCredits(provider, storageKey, costWei) {
  if (!storageKey || !costWei) return;
  try {
    const storageWallet = new ethers.Wallet(storageKey, provider);
    const storageAddress = await storageWallet.getAddress();
    const storageBalance = await provider.getBalance(storageAddress);
    console.log(`🤖 Storage balance: ${ethers.formatEther(storageBalance)} ETH`);
    const storageCostBigInt = BigInt(costWei);
    const gasReserve = ethers.parseEther("0.0001");
    if (storageBalance < storageCostBigInt + gasReserve) {
      console.log('🤖 Not enough funds for credits.');
      return;
    }
    console.log(`🤖 Buying credits for ${ethers.formatEther(costWei)} ETH...`);
    const signer = new EthereumSigner(storageKey);
    const turbo = TurboFactory.authenticated({
      signer, token: 'base-eth', gatewayUrl: 'https://sepolia.base.org',
      paymentServiceConfig: { url: 'https://payment.ardrive.dev' },
      uploadServiceConfig: { url: 'https://upload.ardrive.dev' }
    });
    const { winc: before } = await turbo.getBalance();
    await turbo.topUpWithTokens({ tokenAmount: costWei });
    const { winc: after } = await turbo.getBalance();
    console.log('🤖 ✅ Credits purchased!', { added: (after - before).toString() });
  } catch (creditError) {
    console.warn('⚠️ Credit purchase failed:', creditError.message);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const user = await requireAuth(request, env);
    if (user instanceof Response) return user;
    if (!user?.address) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" }
      });
    }

    const rateKey = `finalize:${user.address.toLowerCase()}`;
    if (!(await checkRateLimit({ key: rateKey, limit: 5, windowMs: 60000 }, env))) {
      return new Response(JSON.stringify({ success: false, error: 'Too many requests' }), {
        status: 429, headers: { "Content-Type": "application/json" }
      });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid JSON' }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    const { wallet, metadataUri, storageCostWei, contentHash } = body;
    if (!wallet || !metadataUri || !ethers.isAddress(wallet)) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid input' }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    if (user.address.toLowerCase() !== wallet.toLowerCase()) {
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized wallet' }), {
        status: 403, headers: { "Content-Type": "application/json" }
      });
    }

    const finalContentHash = (contentHash && /^0x[0-9a-fA-F]{64}$/.test(contentHash))
      ? contentHash : ethers.ZeroHash;

    const fullMetadataUri = parseMetadataUri(metadataUri);

    const CONTRACT_ADDRESS = env.CONTRACT_ADDRESS;
    const ROBOT_PRIVATE_KEY = env.ROBOT_PRIVATE_KEY;
    const ARWEAVE_STORAGE_KEY = env.ARWEAVE_STORAGE_KEY;
    const ALCHEMY_RPC_URL = env.ALCHEMY_RPC_URL;

    if (!CONTRACT_ADDRESS || !ROBOT_PRIVATE_KEY || !ALCHEMY_RPC_URL) {
      return new Response(JSON.stringify({ success: false, error: 'Server configuration incomplete' }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }

    const provider = new ethers.JsonRpcProvider(ALCHEMY_RPC_URL);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, WALLET_NFT_ABI, provider);
    
    let pendingMint;
    try {
      pendingMint = await contract.getPendingMint(wallet);
    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: 'Cannot read pending mint: ' + err.message }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    if (!pendingMint?.exists) {
      return new Response(JSON.stringify({ success: false, error: 'No pending mint found for this wallet' }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    console.log('🔍 FINALIZE MINT DEBUG:', {
      wallet,
      metadataUri: fullMetadataUri,
      storageCostEth: ethers.formatEther(storageCostWei || "0"),
      contentHash: finalContentHash,
      deposit: ethers.formatEther(pendingMint.deposit)
    });

    try {
      await executeRobotFinalize(provider, ROBOT_PRIVATE_KEY, CONTRACT_ADDRESS, {
        wallet, fullMetadataUri, storageCostWei, finalContentHash
      });
      
      // 🆕 Notīra cleanup izsekošanu pēc veiksmīga finalize
      clearPendingTrack(wallet);
      
    } catch (finalizeError) {
      console.error('❌ Finalize failed:', finalizeError.message);
      return new Response(JSON.stringify({ success: false, error: 'Finalize failed: ' + finalizeError.message }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }

    await purchaseStorageCredits(provider, ARWEAVE_STORAGE_KEY, storageCostWei);

    return new Response(JSON.stringify({
      success: true, wallet, metadataUri: fullMetadataUri,
      storageCostWei: storageCostWei || "0", contentHash: finalContentHash
    }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error('💥 Finalize mint error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Server error: ' + error.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}
