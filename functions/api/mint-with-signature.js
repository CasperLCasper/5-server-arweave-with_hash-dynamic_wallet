import { ethers } from 'ethers';
import { requireAuth } from "../_lib/auth.js";
import { checkRateLimit } from "../_lib/rateLimit.js";

const WALLET_NFT_ABI = [
  "function mintWithSignature(address wallet, string calldata metadataUri, bytes32 imageHash, bytes32 videoHash, uint256 nonceParam, bytes calldata signature) external payable",
  "function mintPrice() public view returns (uint256)",
  "function getNonce(address wallet) public view returns (uint256)"
];

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const user = await requireAuth(request, env);
    if (user instanceof Response) return user;
    if (!user || !user.address) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" }
      });
    }

    const rateKey = `mint:${user.address.toLowerCase()}`;
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

    const { wallet, metadataUri, imageHash, videoHash } = body;
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

    if (!imageHash || !/^0x[0-9a-fA-F]{64}$/.test(imageHash)) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid or missing image hash' }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    const finalImageHash = imageHash;
    const finalVideoHash = (videoHash && /^0x[0-9a-fA-F]{64}$/.test(videoHash)) 
      ? videoHash 
      : ethers.ZeroHash;

    let fullMetadataUri = metadataUri.trim();
    
    if (fullMetadataUri.startsWith('Qm') || fullMetadataUri.startsWith('baf')) {
      fullMetadataUri = `https://meaningful-macaw-y3g2r.lighthouseweb3.xyz/ipfs/${fullMetadataUri}`;
    } else if (fullMetadataUri.startsWith('ipfs://')) {
      const cid = fullMetadataUri.substring(7);
      fullMetadataUri = `https://meaningful-macaw-y3g2r.lighthouseweb3.xyz/ipfs/${cid}`;
    }

    const CONTRACT_ADDRESS = env.CONTRACT_ADDRESS;
    const SERVER_PRIVATE_KEY = env.SERVER_PRIVATE_KEY;
    const ALCHEMY_RPC_URL = env.ALCHEMY_RPC_URL;

    if (!CONTRACT_ADDRESS || !SERVER_PRIVATE_KEY || !ALCHEMY_RPC_URL) {
      return new Response(JSON.stringify({ success: false, error: 'Server configuration incomplete' }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }

    const provider = new ethers.JsonRpcProvider(ALCHEMY_RPC_URL);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, WALLET_NFT_ABI, provider);
    
    let mintPrice;
    let currentNonce;
    try {
      mintPrice = await contract.mintPrice();
      currentNonce = await contract.getNonce(wallet); 
    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: 'Cannot read contract state: ' + err.message }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    const serverWallet = new ethers.Wallet(SERVER_PRIVATE_KEY);

    const domain = {
      name: 'WalletVisualizer',
      version: '1',
      chainId: 84532,
      verifyingContract: CONTRACT_ADDRESS
    };

    const types = {
      MintRequest: [
        { name: 'wallet', type: 'address' },
        { name: 'metadataUri', type: 'string' },
        { name: 'imageHash', type: 'bytes32' },
        { name: 'videoHash', type: 'bytes32' },
        { name: 'nonce', type: 'uint256' }
      ]
    };

    const value = {
      wallet: wallet,
      metadataUri: fullMetadataUri,
      imageHash: finalImageHash,
      videoHash: finalVideoHash,
      nonce: currentNonce
    };

    const signature = await serverWallet.signTypedData(domain, types, value);

    const iface = new ethers.Interface(WALLET_NFT_ABI);
    const data = iface.encodeFunctionData('mintWithSignature', [
      wallet, 
      fullMetadataUri, 
      finalImageHash, 
      finalVideoHash, 
      currentNonce, 
      signature
    ]);

    let estimatedGas;
    try {
      estimatedGas = await provider.estimateGas({
        from: wallet,
        to: CONTRACT_ADDRESS,
        data: data,
        value: mintPrice
      });
      estimatedGas = (estimatedGas * 120n) / 100n;
    } catch (err) {
      estimatedGas = 180000n; 
    }

    return new Response(JSON.stringify({
      success: true,
      transaction: {
        to: CONTRACT_ADDRESS,
        data: data,
        value: mintPrice.toString(),
        gasLimit: estimatedGas.toString()
      },
      imageHash: finalImageHash,
      videoHash: finalVideoHash !== ethers.ZeroHash ? finalVideoHash : null,
      metadataUri: fullMetadataUri
    }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: 'Server error: ' + error.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}
