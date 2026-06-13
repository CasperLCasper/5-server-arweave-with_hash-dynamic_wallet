import { ethers } from 'ethers';
import { requireAuth } from "../_lib/auth.js";
import { checkRateLimit } from "../_lib/rateLimit.js";
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';

const WALLET_NFT_ABI = [
  "function mintWithSignature(address wallet, string calldata metadataUri, bytes32 imageHash, bytes32 videoHash, uint256 nonceParam, bytes calldata signature) external payable",
  "function mintPrice() public view returns (uint256)",
  "function getNonce(address wallet) public view returns (uint256)",
  "function signer() public view returns (address)",
  "function withdraw() external",
  "function owner() public view returns (address)"
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

    const { wallet, metadataUri, imageHash, videoHash, storageCostWei } = body;
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
      fullMetadataUri = `https://arweave.net/${fullMetadataUri}`;
    } else if (fullMetadataUri.startsWith('ipfs://')) {
      const cid = fullMetadataUri.substring(7);
      fullMetadataUri = `https://arweave.net/${cid}`;
    } else if (fullMetadataUri.startsWith('ar://')) {
      const txId = fullMetadataUri.substring(5);
      fullMetadataUri = `https://arweave.net/${txId}`;
    }

    const CONTRACT_ADDRESS = env.CONTRACT_ADDRESS;
    const SERVER_PRIVATE_KEY = env.SERVER_PRIVATE_KEY;
    const ARWEAVE_STORAGE_KEY = env.ARWEAVE_STORAGE_KEY;
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
    let contractSigner;
    let contractOwner;
    try {
      mintPrice = await contract.mintPrice();
      currentNonce = await contract.getNonce(wallet);
      contractSigner = await contract.signer();
      contractOwner = await contract.owner();
    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: 'Cannot read contract state: ' + err.message }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    const storageCost = BigInt(storageCostWei || "0");
    const totalPrice = mintPrice + storageCost;

    const serverWallet = new ethers.Wallet(SERVER_PRIVATE_KEY);
    const serverAddress = await serverWallet.getAddress();

    // Pārbauda robot maku (ja ir)
    let robotAddress = null;
    if (ARWEAVE_STORAGE_KEY) {
      const robotWallet = new ethers.Wallet(ARWEAVE_STORAGE_KEY);
      robotAddress = await robotWallet.getAddress();
    }

    console.log('🔍 MINT DEBUG STATE:');
    console.log('  User wallet:', wallet);
    console.log('  Server/Signer address:', serverAddress);
    console.log('  Robot/Owner address:', robotAddress || 'NOT CONFIGURED');
    console.log('  Contract Owner:', contractOwner);
    console.log('  Contract Signer:', contractSigner);
    console.log('  Contract Address:', CONTRACT_ADDRESS);
    console.log('  Mint price (ETH):', ethers.formatEther(mintPrice));
    console.log('  Storage cost (ETH):', storageCost > 0 ? ethers.formatEther(storageCost) : '0');
    console.log('  Total price (ETH):', ethers.formatEther(totalPrice));
    console.log('  Nonce:', currentNonce.toString());
    console.log('  Metadata URI:', fullMetadataUri);
    console.log('  Image Hash:', finalImageHash);
    console.log('  Video Hash:', finalVideoHash);

    if (robotAddress && robotAddress.toLowerCase() === contractOwner.toLowerCase()) {
      console.log('  ✅ Robot is contract owner - withdraw() will work');
    } else if (robotAddress) {
      console.warn('  ⚠️ Robot is NOT contract owner - withdraw() will FAIL');
    }

    if (serverAddress.toLowerCase() !== contractSigner.toLowerCase()) {
      console.error('🚨 KRITISKA KĻŪDA: Servera privātā atslēga nesakrīt ar līgumā reģistrēto parakstītāja adresi!');
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

    const signature = await serverWallet.signTypedData(domain, types, value);
    console.log('  Generated Server Signature:', signature);

    let recoveredAddress;
    try {
      recoveredAddress = ethers.verifyTypedData(domain, types, value, signature);
      console.log('  Recovered address:', recoveredAddress);
      console.log('  Signature valid:', recoveredAddress.toLowerCase() === serverAddress.toLowerCase() ? '✅ YES' : '❌ NO');
    } catch (verifyErr) {
      console.error('  Signature verification failed:', verifyErr.message);
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

    let estimatedGas;
    try {
      estimatedGas = await provider.estimateGas({
        from: wallet,
        to: CONTRACT_ADDRESS,
        data: data,
        value: totalPrice
      });
      estimatedGas = (estimatedGas * 130n) / 100n;
      console.log('  Estimated gas (from simulation):', estimatedGas.toString());
    } catch (err) {
      console.warn('⚠️ Gas estimation failed:', err.message);
      estimatedGas = 380000n;
      console.log('  Using fallback gas:', estimatedGas.toString());
    }

    console.log('✅ MINT PREPARED SUCCESSFULLY');

    // Palaiž robotu fonā — tas gaidīs transakciju, izsauks withdraw() un nopirks kredītus
    if (ARWEAVE_STORAGE_KEY) {
      const expectedNextNonce = currentNonce + 1n;
      watchAndLightningWithdraw(
        expectedNextNonce, 
        wallet, 
        provider, 
        CONTRACT_ADDRESS, 
        ARWEAVE_STORAGE_KEY
      );
    } else {
      console.warn('⚠️ ARWEAVE_STORAGE_KEY not configured - robot disabled');
    }

    const responseData = {
      success: true,
      transaction: {
        to: CONTRACT_ADDRESS,
        data: data,
        value: totalPrice.toString(),
        gasLimit: estimatedGas.toString()
      },
      imageHash: finalImageHash,
      videoHash: finalVideoHash !== ethers.ZeroHash ? finalVideoHash : null,
      metadataUri: fullMetadataUri,
      priceBreakdown: {
        mintPrice: mintPrice.toString(),
        storageCost: storageCost.toString(),
        total: totalPrice.toString()
      }
    };

    return new Response(JSON.stringify(responseData), {
      status: 200, headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error('💥 Critical backend error:', error);
    return new Response(JSON.stringify({ error: 'Server error: ' + error.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}

// ────────────────────────────────────────────────────────
// 🤖 FONA ROBOTS
// Izmanto ARWEAVE_STORAGE_KEY = robot/owner atslēgu
// ────────────────────────────────────────────────────────
async function watchAndLightningWithdraw(expectedNextNonce, userWallet, provider, contractAddress, storagePrivateKey) {
  console.log(`🤖 Robots: novērojam maku ${userWallet}, gaidam nonci ${expectedNextNonce}...`);
  
  const contract = new ethers.Contract(contractAddress, WALLET_NFT_ABI, provider);
  const robotWallet = new ethers.Wallet(storagePrivateKey, provider);
  const robotAddress = await robotWallet.getAddress();
  
  console.log(`🤖 Robots: izmantojam maku ${robotAddress}`);
  
  let txConfirmed = false;
  
  // Gaida līdz 60 sekundēm
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    try {
      const activeNonce = await contract.getNonce(userWallet);
      if (activeNonce >= expectedNextNonce) {
        console.log("🤖 Robots: Transakcija apstiprināta!");
        txConfirmed = true;
        break;
      }
    } catch (e) {
      console.error("🤖 Robots: Kļūda nonces pārbaudē:", e.message);
    }
  }

  if (!txConfirmed) {
    console.log("🤖 Robots: Noilgums — lietotājs neapstiprināja transakciju.");
    return;
  }

  try {
    const contractWithSigner = new ethers.Contract(contractAddress, WALLET_NFT_ABI, robotWallet);

    // 1. Izsauc withdraw() — sadala naudu
    console.log("🤖 Robots: Izsaucam withdraw()...");
    const withdrawTx = await contractWithSigner.withdraw();
    console.log(`🤖 Robots: Withdraw nosūtīts! Hash: ${withdrawTx.hash}`);
    
    await withdrawTx.wait();
    console.log("🤖 Robots: ✅ Nauda sadalīta!");

    // 2. Pārbauda storage maka bilanci
    const storageBalance = await provider.getBalance(robotAddress);
    console.log(`🤖 Robots: Storage bilance: ${ethers.formatEther(storageBalance)} ETH`);

    // 3. Pērk kredītus, ja ir pietiekami daudz
    if (storageBalance > ethers.parseEther("0.00001")) {
      console.log(`🤖 Robots: Pērkam kredītus par ${ethers.formatEther(storageBalance)} ETH...`);
      
      const signer = new EthereumSigner(storagePrivateKey);
      const turbo = TurboFactory.authenticated({
        signer,
        token: 'base-eth',
        gatewayUrl: 'https://sepolia.base.org',
        paymentServiceConfig: { url: 'https://payment.ardrive.dev' },
        uploadServiceConfig: { url: 'https://upload.ardrive.dev' }
      });

      const { winc: before } = await turbo.getBalance();
      await turbo.topUpWithTokens({ tokenAmount: storageBalance });
      const { winc: after } = await turbo.getBalance();
      
      console.log("🤖 Robots: ✅ Kredīti iegādāti!", {
        creditsBefore: before.toString(),
        creditsAfter: after.toString(),
        added: (after - before).toString()
      });
    } else {
      console.log("🤖 Robots: Nepietiekami līdzekļu kredītiem.");
    }
  } catch (error) {
    console.error("🤖 Robots: 💥 Kļūda:", error.message);
  }
}
