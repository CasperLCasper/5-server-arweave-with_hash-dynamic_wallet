// functions/api/robot-withdraw-and-buy.js
import { ethers } from 'ethers';
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';

const WALLET_NFT_ABI = [
  "function withdraw(uint256 storageCostWei) external"
];

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { txHash, storageCostWei } = body;

    if (!txHash || !storageCostWei) {
      return new Response(JSON.stringify({ success: false, error: 'Missing txHash or storageCostWei' }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    console.log(`🤖 Robot: started for tx ${txHash}, storageCost: ${ethers.formatEther(storageCostWei)} ETH`);

    const ROBOT_PRIVATE_KEY = env.ROBOT_PRIVATE_KEY;
    const ARWEAVE_STORAGE_KEY = env.ARWEAVE_STORAGE_KEY;
    const CONTRACT_ADDRESS = env.CONTRACT_ADDRESS;
    const ALCHEMY_RPC_URL = env.ALCHEMY_RPC_URL || 'https://sepolia.base.org';

    if (!ROBOT_PRIVATE_KEY) throw new Error('ROBOT_PRIVATE_KEY not configured');
    if (!ARWEAVE_STORAGE_KEY) throw new Error('ARWEAVE_STORAGE_KEY not configured');
    if (!CONTRACT_ADDRESS) throw new Error('CONTRACT_ADDRESS not configured');

    const provider = new ethers.JsonRpcProvider(ALCHEMY_RPC_URL);
    
    // 1. Withdraw robots — izsauc withdraw(storageCostWei)
    const robotWallet = new ethers.Wallet(ROBOT_PRIVATE_KEY, provider);
    const robotAddress = await robotWallet.getAddress();
    const contract = new ethers.Contract(CONTRACT_ADDRESS, WALLET_NFT_ABI, robotWallet);
    
    console.log(`🤖 Withdraw robot (${robotAddress}): calling withdraw(${storageCostWei})...`);
    const withdrawTx = await contract.withdraw(storageCostWei);
    console.log(`🤖 Withdraw robot: tx sent! Hash: ${withdrawTx.hash}`);
    await withdrawTx.wait();
    console.log('🤖 Withdraw robot: ✅ Funds distributed!');

    // 2. Webhook robots — pērk kredītus TIKAI par storageCostWei
    const storageWallet = new ethers.Wallet(ARWEAVE_STORAGE_KEY, provider);
    const storageAddress = await storageWallet.getAddress();
    const storageBalance = await provider.getBalance(storageAddress);
    
    console.log(`🤖 Webhook robot: storage balance: ${ethers.formatEther(storageBalance)} ETH`);

    const storageCostBigInt = BigInt(storageCostWei);
    const gasReserve = ethers.parseEther("0.0001");
    
    if (storageBalance >= storageCostBigInt + gasReserve) {
      console.log(`🤖 Webhook robot: buying credits for ${ethers.formatEther(storageCostWei)} ETH...`);
      
      const signer = new EthereumSigner(ARWEAVE_STORAGE_KEY);
      const turbo = TurboFactory.authenticated({
        signer,
        token: 'base-eth',
        gatewayUrl: 'https://sepolia.base.org',
        paymentServiceConfig: { url: 'https://payment.ardrive.dev' },
        uploadServiceConfig: { url: 'https://upload.ardrive.dev' }
      });

      const { winc: before } = await turbo.getBalance();
      await turbo.topUpWithTokens({ tokenAmount: storageCostWei });
      const { winc: after } = await turbo.getBalance();
      
      console.log('🤖 Webhook robot: ✅ Credits purchased!', {
        ethSpent: ethers.formatEther(storageCostWei),
        gasReserveLeft: ethers.formatEther(gasReserve),
        creditsBefore: before.toString(),
        creditsAfter: after.toString(),
        added: (after - before).toString()
      });
    } else {
      console.log(`🤖 Webhook robot: not enough funds. Need ${ethers.formatEther(storageCostBigInt + gasReserve)} ETH, have ${ethers.formatEther(storageBalance)} ETH`);
    }

    return new Response(JSON.stringify({
      success: true,
      withdrawTx: withdrawTx.hash,
      storageBalance: storageBalance.toString(),
      creditsPurchased: storageCostWei
    }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error('💥 Robot error:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}
