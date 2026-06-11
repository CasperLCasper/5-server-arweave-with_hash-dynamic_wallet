import { ethers } from 'ethers';
import { requireAuth } from "../_lib/auth.js";
import { checkRateLimit } from "../_lib/rateLimit.js";

const WALLET_NFT_ABI = [
  "function mintWithSignature(address wallet, string calldata metadataUri, bytes32 imageHash, bytes32 videoHash, uint256 nonceParam, bytes calldata signature) external payable",
  "function mintPrice() public view returns (uint256)",
  "function getNonce(address wallet) public view returns (uint256)",
  "function signer() public view returns (address)"
];

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // 1. Lietotāja sesijas un autentifikācijas pārbaude
    const user = await requireAuth(request, env);
    if (user instanceof Response) return user;
    if (!user || !user.address) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" }
      });
    }

    // 2. Drošības ierobežojums (Rate-limit), lai neappludinātu API
    const rateKey = `mint:${user.address.toLowerCase()}`;
    if (!(await checkRateLimit({ key: rateKey, limit: 5, windowMs: 60000 }, env))) {
      return new Response(JSON.stringify({ success: false, error: 'Too many requests' }), {
        status: 429, headers: { "Content-Type": "application/json" }
      });
    }

    // 3. Pieprasījuma datu nolasīšana un validācija
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

    // 4. Arweave / IPFS vārdu telpas standartizācija uz pastāvīgo Turbo Gateway
    let fullMetadataUri = metadataUri.trim();
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

    // 5. Dinamiskā stāvokļa nolasīšana tieši no viedā līguma
    const provider = new ethers.JsonRpcProvider(ALCHEMY_RPC_URL);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, WALLET_NFT_ABI, provider);
    
    let mintPrice;
    let currentNonce;
    let contractSigner;
    try {
      mintPrice = await contract.mintPrice();
      currentNonce = await contract.getNonce(wallet);
      contractSigner = await contract.signer();
    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: 'Cannot read contract state: ' + err.message }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    const serverWallet = new ethers.Wallet(SERVER_PRIVATE_KEY);
    const serverAddress = await serverWallet.getAddress();

    console.log('🔍 MINT DEBUG STATE:');
    console.log('  User wallet:', wallet);
    console.log('  Server address (Backend):', serverAddress);
    console.log('  Registered Signer in Contract:', contractSigner);
    console.log('  Contract Address:', CONTRACT_ADDRESS);
    console.log('  Mint price (ETH):', ethers.formatEther(mintPrice));
    console.log('  Nonce:', currentNonce.toString());

    if (serverAddress.toLowerCase() !== contractSigner.toLowerCase()) {
      console.error('🚨 KRITISKA KĻŪDA: Servera privātā atslēga nesakrīt ar līgumā reģistrēto parakstītāja adresi!');
    }

    // 6. EIP-712 Domēna definīcija (Precīza atbilstība Solidity EIP712 konstruktoram)
    const domain = {
      name: 'WalletVisualizer',
      version: '1',
      chainId: 84532, // Base Sepolia testnet ID
      verifyingContract: CONTRACT_ADDRESS
    };

    // 7. EIP-712 Tipu definīcija (Precīza atbilstība MINT_TYPEHASH struktūrai un secībai līgumā)
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
      nonce: Number(currentNonce) // Nodrošinām pareizu datu tipu bibliotēkas apstrādei
    };

    // 8. Kriptogrāfiskā paraksta ģenerēšana servera pusē ar privāto atslēgu
    const signature = await serverWallet.signTypedData(domain, types, value);
    console.log('  Generated Server Signature:', signature);

    // 9. Transakcijas Calldata sagatavošana (enkodēšana) priekš kontrakta izsaukuma
    const iface = new ethers.Interface(WALLET_NFT_ABI);
    const data = iface.encodeFunctionData('mintWithSignature', [
      wallet, 
      fullMetadataUri, 
      finalImageHash, 
      finalVideoHash, 
      currentNonce, 
      signature
    ]);

    // 10. Gāzes simulācija (ja tā neizdodas, nepārtraucam darbu, bet iedodam drošu noklusēto limitu)
    let estimatedGas;
    try {
      estimatedGas = await provider.estimateGas({
        from: wallet,
        to: CONTRACT_ADDRESS,
        data: data,
        value: mintPrice
      });
      estimatedGas = (estimatedGas * 130n) / 100n; // 30% buferis drošībai tīkla noslodzes brīžos
    } catch (err) {
      console.warn('⚠️ Server-side simulation skipped. Using safe fallback limit. Reason:', err.message);
      estimatedGas = 380000n; // Stabils limits ERC721A mintēšanai ar string un hash ierakstiem stāvoklī
    }

    console.log('  Gas limit passed to frontend:', estimatedGas.toString());
    console.log('✅ MINT PREPARED SUCCESSFULLY');

    // 11. Transakcijas parametru atgriešana frontendam parakstīšanai un nosūtīšanai
    const responseData = {
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
    };

    return new Response(JSON.stringify(responseData), {
      status: 200, headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error('💥 Critical backend error:', error);
    return new Response(JSON.stringify({ success: false, error: 'Server error: ' + error.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}
