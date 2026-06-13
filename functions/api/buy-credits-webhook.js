import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';
import { ethers } from 'ethers';

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

    console.log(`🔄 Webhook: Buying Turbo Credits from ${ethers.formatEther(ethAmount)} ETH (tx: ${txHash})...`);

    const privateKey = env.ARWEAVE_STORAGE_KEY;
    if (!privateKey) {
      throw new Error('ARWEAVE_STORAGE_KEY not configured');
    }

    const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
    const wallet = new ethers.Wallet(privateKey, provider);
    const address = await wallet.getAddress();

    const signer = new EthereumSigner(privateKey);
    const turbo = TurboFactory.authenticated({
      signer,
      token: 'base-eth',
      gatewayUrl: 'https://sepolia.base.org',
      paymentServiceConfig: { url: 'https://payment.ardrive.dev' },
      uploadServiceConfig: { url: 'https://upload.ardrive.dev' }
    });

    // Pārbauda bilanci pirms
    const { winc: creditsBefore } = await turbo.getBalance();
    
    // 80% no storage daļas aiziet kredītos, 20% paliek kā rezerve
    const amountForCredits = (BigInt(ethAmount) * 80n) / 100n;
    
    if (amountForCredits <= 0) {
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'Amount too small for credits' 
      }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    const result = await turbo.topUpWithTokens({ 
      tokenAmount: amountForCredits 
    });

    const { winc: creditsAfter } = await turbo.getBalance();

    console.log('✅ Credits purchased:', {
      ethSpent: ethers.formatEther(amountForCredits),
      creditsBefore: creditsBefore.toString(),
      creditsAfter: creditsAfter.toString(),
      added: (creditsAfter - creditsBefore).toString()
    });

    return new Response(JSON.stringify({
      success: true,
      ethSpent: ethers.formatEther(amountForCredits),
      creditsBefore: creditsBefore.toString(),
      creditsAfter: creditsAfter.toString(),
      added: (creditsAfter - creditsBefore).toString()
    }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error('💥 Webhook credit purchase error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}
