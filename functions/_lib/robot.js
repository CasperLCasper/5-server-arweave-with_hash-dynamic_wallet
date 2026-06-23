import { ethers } from 'ethers';

let globalNonceManager = null;

export function getRobotSigner(env, provider) {
  if (!globalNonceManager) {
    const robotWallet = new ethers.Wallet(env.ROBOT_PRIVATE_KEY, provider);
    globalNonceManager = new ethers.NonceManager(robotWallet);
    console.log('🤖 Global NonceManager initialized');
  }
  return globalNonceManager;
}
