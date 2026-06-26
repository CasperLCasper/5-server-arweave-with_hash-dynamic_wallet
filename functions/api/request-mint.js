// functions/api/request-mint.js
import { ethers } from 'ethers';
import { requireAuth } from "../_lib/auth.js";
import { checkRateLimit } from "../_lib/rateLimit.js";
import { trackPendingMint } from "./cleanup-pending.js";

const WALLET_NFT_ABI = [
  "function requestMint(address wallet, bytes32 imageHash, bytes32 videoHash, bytes32 contentHash, uint256 nonceParam, bytes calldata signature) external payable",
  "function mintPrice() public view returns (uint256)",
  "function getNonce(address wallet) public view returns (uint256)",
  "function signer() public view returns (address)"
];

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function validateRequestBody(body) {
  const { wallet, imageHash, videoHash, contentHash } = body || {};
  
  if (!wallet || !ethers.isAddress(wallet)) {
    return { error: 'Invalid input' };
  }
  
  if (!imageHash || !/^0x[0-9a-fA-F]{64}$/.test(imageHash)) {
    return { error: 'Invalid or missing image hash' };
  }
  
  return {
    wallet,
    imageHash,
    videoHash: (videoHash && /^0x[0-9a-fA-F]{64}$/.test(videoHash)) ? videoHash : ethers.ZeroHash,
    contentHash: (contentHash && /^0x[0-9a-fA-F]{64}$/.test(contentHash)) ? contentHash : ethers.ZeroHash
  };
}

function validateUserWalletMatch(user, wallet) {
  if (user.address.toLowerCase() !== wallet.toLowerCase()) {
    return { error: 'Unauthorized wallet' };
  }
  return {};
}

async function getContractState(contract, wallet) {
  try {
    const [mintPrice, currentNonce, contractSigner] = await Promise.all([
      contract.mintPrice(),
      contract.getNonce(wallet),
      contract.signer()
    ]);
    return { mintPrice, currentNonce, contractSigner };
  } catch (err) {
    return { error: 'Cannot read contract state: ' + err.message };
  }
}

async function generateMintSignature(serverWallet, contractAddress, wallet, hashes, nonce) {
  const domain = {
    name: 'WalletVisualizer',
    version: '1',
    chainId: 84532,
    verifyingContract: contractAddress
  };

  const types = {
    MintRequest: [
      { name: 'wallet', type: 'address' },
      { name: 'imageHash', type: 'bytes32' },
      { name: 'videoHash', type: 'bytes32' },
      { name: 'contentHash', type: 'bytes32' },
      { name: 'nonce', type: 'uint256' }
    ]
  };

  const value = {
    wallet,
    imageHash: hashes.imageHash,
    videoHash: hashes.videoHash,
    contentHash: hashes.contentHash,
    nonce
  };

  return await serverWallet.signTypedData(domain, types, value);
}

async function estimateGasWithFallback(provider, wallet, contractAddress, data, value) {
  try {
    const estimated = await provider.estimateGas({
      from: wallet,
      to: contractAddress,
      data,
      value
    });
    return (estimated * 130n) / 100n;
  } catch (err) {
    return 380000n;
  }
}

function prepareTransactionData(wallet, hashes, nonce, signature) {
  const iface = new ethers.Interface(WALLET_NFT_ABI);
  return iface.encodeFunctionData('requestMint', [
    wallet,
    hashes.imageHash,
    hashes.videoHash,
    hashes.contentHash,
    nonce,
    signature
  ]);
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
    const rateKey = `mint:${user.address.toLowerCase()}`;
    if (!(await checkRateLimit({ key: rateKey, limit: 5, windowMs: 60000 }, env))) {
      return jsonResponse({ success: false, error: 'Too many requests' }, 429);
    }

    // Request body validācija
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ success: false, error: 'Invalid JSON' }, 400);
    }

    const { wallet, imageHash, videoHash, contentHash, error: bodyError } = validateRequestBody(body);
    if (bodyError) return jsonResponse({ success: false, error: bodyError }, 400);

    const { error: userError } = validateUserWalletMatch(user, wallet);
    if (userError) return jsonResponse({ success: false, error: userError }, 403);

    // Env validācija
    const { CONTRACT_ADDRESS, SERVER_PRIVATE_KEY, ALCHEMY_RPC_URL } = env;
    if (!CONTRACT_ADDRESS || !SERVER_PRIVATE_KEY || !ALCHEMY_RPC_URL) {
      return jsonResponse({ success: false, error: 'Server configuration incomplete' }, 500);
    }

    // Līguma inicializācija
    const provider = new ethers.JsonRpcProvider(ALCHEMY_RPC_URL);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, WALLET_NFT_ABI, provider);
    
    const { mintPrice, currentNonce, contractSigner, error: stateError } = await getContractState(contract, wallet);
    if (stateError) return jsonResponse({ success: false, error: stateError }, 400);

    // Debug info
    const serverWallet = new ethers.Wallet(SERVER_PRIVATE_KEY);
    const serverAddress = await serverWallet.getAddress();

    console.log('🔍 REQUEST MINT DEBUG:');
    console.log('  User wallet:', wallet);
    console.log('  Server/Signer address:', serverAddress);
    console.log('  Contract Signer:', contractSigner);
    console.log('  Contract Address:', CONTRACT_ADDRESS);
    console.log('  Mint price (ETH):', ethers.formatEther(mintPrice));
    console.log('  Nonce:', currentNonce.toString());

    if (serverAddress.toLowerCase() !== contractSigner.toLowerCase()) {
      console.error('🚨 Signer mismatch!');
    }

    // Signatūras ģenerēšana
    const hashes = { imageHash, videoHash, contentHash };
    const signature = await generateMintSignature(serverWallet, CONTRACT_ADDRESS, wallet, hashes, currentNonce);

    // Transakcijas sagatavošana
    const data = prepareTransactionData(wallet, hashes, currentNonce, signature);
    const estimatedGas = await estimateGasWithFallback(provider, wallet, CONTRACT_ADDRESS, data, mintPrice);

    // Track pending mint
    trackPendingMint(wallet);

    return jsonResponse({
      success: true,
      transaction: {
        to: CONTRACT_ADDRESS,
        data,
        value: mintPrice.toString(),
        gasLimit: estimatedGas.toString()
      },
      imageHash,
      videoHash: videoHash !== ethers.ZeroHash ? videoHash : null,
      contentHash: contentHash !== ethers.ZeroHash ? contentHash : null
    });

  } catch (error) {
    console.error('💥 Request mint error:', error);
    return jsonResponse({ error: 'Server error: ' + error.message }, 500);
  }
}
