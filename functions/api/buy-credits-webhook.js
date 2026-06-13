// functions/api/buy-credits-webhook.js
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';
import { ethers } from 'ethers';

const WALLET_NFT_ABI = [
  "function withdraw() external"
];

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { txHash, ethAmount } = body;

    if (!txHash || !ethAmount) {
      return new Response(JSON.stringify({ success: false, error: 'Missing txHash or ethAmount' }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    console.log(`🔄 Webhook: processing tx ${txHash}, amount: ${ethers.formatEther(ethAmount)} ETH`);

    const privateKey = env.ARWEAVE_STORAGE_KEY;
    const contractAddress = env.CONTRACT_ADDRESS;
    const rpcUrl = env.ALCHEMY_RPC_URL || 'https://sepolia.base.org';

    if (!privateKey) throw new Error('ARWEAVE_STORAGE_KEY not configured');
    if (!contractAddress) throw new Error('CONTRACT_ADDRESS not configured');

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);

    // 1. Izsauc kontrakta withdraw()
    console.log('📤 Calling withdraw() on contract...');
    const contract = new ethers.Contract(contractAddress, WALLET_NFT_ABI, wallet);
    const tx = await contract.withdraw();
    await tx.wait();
    console.log('✅ withdraw() successful:', tx.hash);

    // 2. Pērk kredītus TIKAI par šī NFT storage summu
    const signer = new EthereumSigner(privateKey);
    const turbo = TurboFactory.authenticated({
      signer,
      token: 'base-eth',
      gatewayUrl: 'https://sepolia.base.org',
      paymentServiceConfig: { url: 'https://payment.ardrive.dev' },
      uploadServiceConfig: { url: 'https://upload.ardrive.dev' }
    });

    const { winc: creditsBefore } = await turbo.getBalance();
    
    console.log(`💳 Buying credits for ${ethers.formatEther(ethAmount)} ETH...`);
    await turbo.topUpWithTokens({ tokenAmount: ethAmount });

    const { winc: creditsAfter } = await turbo.getBalance();

    console.log('✅ Credits purchased:', {
      ethSpent: ethers.formatEther(ethAmount),
      creditsBefore: creditsBefore.toString(),
      creditsAfter: creditsAfter.toString(),
      added: (creditsAfter - creditsBefore).toString()
    });

    return new Response(JSON.stringify({
      success: true,
      txHash: tx.hash,
      ethSpent: ethers.formatEther(ethAmount),
      creditsBefore: creditsBefore.toString(),
      creditsAfter: creditsAfter.toString(),
      added: (creditsAfter - creditsBefore).toString()
    }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error('💥 Webhook error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}
