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
    
    // Handle Arweave transaction IDs
    if (fullMetadataUri.startsWith('Qm') || fullMetadataUri.startsWith('baf')) {
      fullMetadataUri = `https://turbo-gateway.com/${fullMetadataUri}`;
    } else if (fullMetadataUri.startsWith('ipfs://')) {
      const cid = fullMetadataUri.substring(7);
      fullMetadataUri = `https://turbo-gateway.com/${cid}`;
    } else if (fullMetadataUri.startsWith('ar://')) {
      const txId = fullMetadataUri.substring(5);
      fullMetadataUri = `https://turbo-gateway.com/${txId}`;
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
    const serverAddress = await serverWallet.getAddress();

    // 🔍 DEBUG: Izvada visu informāciju priekš diagnostikas
    console.log('═══════════════════════════════════════');
    console.log('🔍 MINT DIAGNOSTICS START');
    console.log('═══════════════════════════════════════');
    console.log('📋 User wallet:', wallet);
    console.log('📋 Server signer address:', serverAddress);
    console.log('📋 Contract address:', CONTRACT_ADDRESS);
    console.log('📋 Mint price (wei):', mintPrice.toString());
    console.log('📋 Mint price (ETH):', ethers.formatEther(mintPrice));
    console.log('📋 Current nonce for user:', currentNonce.toString());
    console.log('📋 Image hash:', finalImageHash);
    console.log('📋 Video hash:', finalVideoHash);
    console.log('📋 Metadata URI:', fullMetadataUri);

    // Pārbauda signer adresi kontraktā (ja kontraktam ir šāda funkcija)
    try {
      // Mēģinām nolasīt signer no kontrakta (ja ir public mainīgais)
      const contractSigner = await contract.signer();
      console.log('📋 Contract signer variable:', contractSigner);
      console.log('✅ Signer match:', contractSigner.toLowerCase() === serverAddress.toLowerCase() ? 'YES ✅' : 'NO ❌');
    } catch (e) {
      // Kontraktam nav šādas funkcijas, tas ir OK
      console.log('⚠️ Cannot read signer from contract (may not have public getter):', e.message);
    }

    // Pārbauda serverWallet adreses ETH bilanci
    try {
      const serverBalance = await provider.getBalance(serverAddress);
      console.log('📋 Server wallet ETH balance:', ethers.formatEther(serverBalance), 'ETH');
      console.log('📋 Sufficient for mint?', serverBalance >= mintPrice ? 'YES ✅' : 'NO ❌ - NEED MORE ETH');
    } catch (e) {
      console.log('⚠️ Cannot check server balance:', e.message);
    }

    // Pārbauda lietotāja ETH bilanci
    try {
      const userBalance = await provider.getBalance(wallet);
      console.log('📋 User wallet ETH balance:', ethers.formatEther(userBalance), 'ETH');
      console.log('📋 User sufficient for mint?', userBalance >= mintPrice ? 'YES ✅' : 'NO ❌');
    } catch (e) {
      console.log('⚠️ Cannot check user balance:', e.message);
    }

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

    console.log('📋 Domain separator:', JSON.stringify(domain, null, 2));
    console.log('📋 Value to sign:', JSON.stringify(value, null, 2));

    let signature;
    try {
      signature = await serverWallet.signTypedData(domain, types, value);
      console.log('📋 Signature:', signature);
    } catch (signErr) {
      console.error('❌ Signing failed:', signErr);
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Signing failed: ' + signErr.message 
      }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }

    // Verify the signature locally
    try {
      const recoveredAddress = ethers.verifyTypedData(domain, types, value, signature);
      console.log('📋 Recovered address from signature:', recoveredAddress);
      console.log('✅ Signature verification:', recoveredAddress.toLowerCase() === serverAddress.toLowerCase() ? 'VALID ✅' : 'INVALID ❌');
    } catch (verifyErr) {
      console.error('❌ Local signature verification failed:', verifyErr.message);
    }

    const iface = new ethers.Interface(WALLET_NFT_ABI);
    const data = iface.encodeFunctionData('mintWithSignature', [
      wallet, 
      fullMetadataUri, 
      finalImageHash, 
      finalVideoHash, 
      currentNonce, 
      signature
    ]);

    console.log('📋 Encoded function data:', data);

    let estimatedGas;
    try {
      estimatedGas = await provider.estimateGas({
        from: wallet,
        to: CONTRACT_ADDRESS,
        data: data,
        value: mintPrice
      });
      estimatedGas = (estimatedGas * 120n) / 100n;
      console.log('📋 Estimated gas:', estimatedGas.toString());
    } catch (gasErr) {
      console.error('⚠️ Gas estimation failed (this is a strong indicator of revert):', gasErr.message);
      estimatedGas = 350000n;
      console.log('📋 Using fallback gas:', estimatedGas.toString());
    }

    console.log('═══════════════════════════════════════');
    console.log('🔍 MINT DIAGNOSTICS END');
    console.log('═══════════════════════════════════════');

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
      metadataUri: fullMetadataUri,
      // Pievieno diagnostikas info priekš frontend
      debug: {
        serverAddress,
        mintPriceWei: mintPrice.toString(),
        mintPriceEth: ethers.formatEther(mintPrice),
        currentNonce: currentNonce.toString(),
        estimatedGas: estimatedGas.toString()
      }
    }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error('💥 Unhandled error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Server error: ' + error.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}
