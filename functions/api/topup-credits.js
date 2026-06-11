// functions/api/topup-credits.js
import { TurboFactory, EthereumSigner, ETHToTokenAmount } from '@ardrive/turbo-sdk';
import { ethers } from 'ethers';

export async function onRequestGet(context) {
  const { env } = context;

  try {
    const privateKey = env.ARWEAVE_STORAGE_KEY;
    if (!privateKey) {
      return new Response(JSON.stringify({ error: 'ARWEAVE_STORAGE_KEY not configured' }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }

    const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
    const wallet = new ethers.Wallet(privateKey, provider);
    const address = await wallet.getAddress();

    const ethBalance = await provider.getBalance(address);
    console.log('💰 ETH bilance:', ethers.formatEther(ethBalance), 'ETH');

    // Fiksēta summa: 0.001 ETH
    const topUpAmountEth = '0.001';
    const topUpAmountWei = ethers.parseEther(topUpAmountEth);

    if (ethBalance < topUpAmountWei) {
      return new Response(JSON.stringify({ 
        error: `Nepietiekami ETH. Vajag vismaz ${topUpAmountEth} ETH.`,
        address: address,
        balance: ethers.formatEther(ethBalance)
      }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    const signer = new EthereumSigner(privateKey);
    const turbo = TurboFactory.authenticated({
      signer,
      token: 'base-eth',
      gatewayUrl: 'https://sepolia.base.org',
      paymentServiceConfig: { url: 'https://payment.ardrive.dev' },
      uploadServiceConfig: { url: 'https://upload.ardrive.dev' }
    });

    const { winc: balanceBefore } = await turbo.getBalance();
    console.log('📊 Kredīti pirms:', balanceBefore.toString(), 'Winston Credits');

    const result = await turbo.topUpWithTokens({ tokenAmount: topUpAmountWei });
    const { winc: balanceAfter } = await turbo.getBalance();
    console.log('📊 Kredīti pēc:', balanceAfter.toString(), 'Winston Credits');

    return new Response(JSON.stringify({
      success: true,
      address: address,
      ethBalance: ethers.formatEther(ethBalance),
      topUpAmount: topUpAmountEth + ' ETH',
      creditsBefore: balanceBefore.toString(),
      creditsAfter: balanceAfter.toString(),
      added: (balanceAfter - balanceBefore).toString()
    }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error('💥 Topup error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}
