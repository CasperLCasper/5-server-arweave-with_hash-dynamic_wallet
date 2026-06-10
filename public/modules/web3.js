// ============================================ //
// WEB3 FUNCTIONS
// ============================================ //

import { VIZ_CHAINS, MINT_CHAIN, getAllRpcUrls, getRpcUrl } from './chains.js';
import { UI } from './state.js';
import { showToast, setButtonLoading, showProgress, hideProgress } from './ui.js';
import { login, getNFTPrice, getContractAddress } from './api.js';

export async function updateChainStatus() {
  if (!window.ethereum || !UI.chainStatus) return;
  
  try {
    const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
    const selectedChainKey = UI.chainSelect ? UI.chainSelect.value : null;
    const selectedChain = VIZ_CHAINS[selectedChainKey];
    
    if (selectedChain && chainIdHex && chainIdHex.toLowerCase() === selectedChain.chainIdHex.toLowerCase()) {
      UI.chainStatus.className = 'chain-status connected';
      UI.chainStatus.title = `✓ Connected to ${selectedChain.name}`;
    } else {
      UI.chainStatus.className = 'chain-status disconnected';
      UI.chainStatus.title = '⚠️ Please switch network in your wallet';
    }
  } catch (error) {
    UI.chainStatus.className = 'chain-status disconnected';
    UI.chainStatus.title = '❌ Unable to detect network';
  }
}

export async function switchToMintChain() {
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: MINT_CHAIN.chainIdHex }]
    });
  } catch (error) {
    if (error.code === 4902) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: MINT_CHAIN.chainIdHex,
          chainName: MINT_CHAIN.name,
          nativeCurrency: { name: MINT_CHAIN.nativeCurrency, symbol: MINT_CHAIN.nativeCurrency, decimals: 18 },
          rpcUrls: getAllRpcUrls('baseSepolia'),
          blockExplorerUrls: [MINT_CHAIN.blockExplorer]
        }]
      });
    } else {
      throw error;
    }
  }
}

export async function switchToVizChain(chainIdHex) {
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainIdHex }]
    });
    await updateChainStatus();
  } catch (error) {
    const isNetworkMissing = 
      error.code === 4902 || 
      (error.message && error.message.includes('not supported')) ||
      (error.message && error.message.includes('wallet_switchEthereumChain'));

    if (isNetworkMissing) {
      const chainConfig = Object.values(VIZ_CHAINS).find(
        c => c.chainIdHex && chainIdHex && c.chainIdHex.toLowerCase() === chainIdHex.toLowerCase()
      );
      
      if (chainConfig) {
        const isAmoy = chainConfig.chainIdHex.toLowerCase() === '0x13882';
        
        const currencySymbol = isAmoy ? 'POL' : (chainConfig.nativeCurrency || 'ETH');
        const explorerUrl = isAmoy ? 'https://amoy.polygonscan.com/' : chainConfig.blockExplorer;
        const rpcUrlsArray = isAmoy ? ['https://rpc-amoy.polygon.technology'] : (Array.isArray(chainConfig.rpc) ? chainConfig.rpc : [chainConfig.rpc]);

        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: chainConfig.chainIdHex,
            chainName: isAmoy ? 'Polygon Amoy Testnet' : chainConfig.name,
            nativeCurrency: { 
              name: currencySymbol, 
              symbol: currencySymbol, 
              decimals: 18 
            },
            rpcUrls: rpcUrlsArray,
            blockExplorerUrls: explorerUrl ? [explorerUrl] : []
          }]
        });
        await updateChainStatus();
      }
    } else {
      throw error;
    }
  }
}

async function updateBalanceDisplay(account) {
  const balanceDisplay = document.getElementById('balanceDisplay');
  if (!balanceDisplay) return;
  
  try {
    balanceDisplay.textContent = '💰 Checking balance...';
    balanceDisplay.className = 'balance-display checking';
    
    // 1. Noskaidrojam, kura vizualizācijas ķēde šobrīd ir izvēlēta dropdownā
    const selectedChainKey = UI.chainSelect ? UI.chainSelect.value : null;
    const selectedChain = VIZ_CHAINS[selectedChainKey];
    
    // Ja ķēde ir Amoy, tās simbols būs POL, citreiz ETH vai tas, kas norādīts konfigurācijā
    const isAmoy = selectedChain?.chainIdHex?.toLowerCase() === '0x13882';
    const vizTokenSymbol = isAmoy ? 'POL' : (selectedChain?.nativeCurrency || 'ETH');
    
    // 2. Šeit paliek viedlīguma dati no Base Sepolia (kur maksā par mintošanu)
    const baseMintRpc = getRpcUrl('baseSepolia') || 'https://sepolia.base.org';
    const baseProvider = new ethers.JsonRpcProvider(baseMintRpc);
    const contractAddress = await getContractAddress();
    
    if (!contractAddress) {
      throw new Error('Contract not found');
    }
    
    const contract = new ethers.Contract(contractAddress, ["function mintPrice() view returns (uint256)"], baseProvider);
    const mintPriceWei = await contract.mintPrice();
    const balanceWei = await baseProvider.getBalance(account);
    
    const balanceEth = Number.parseFloat(ethers.formatEther(balanceWei)).toFixed(5);
    const mintPriceEth = Number.parseFloat(ethers.formatEther(mintPriceWei)).toFixed(5);
    
    // 3. ✅ STRATĒĢISKAIS LABOJUMS:
    // Tā kā tavs līgums fiziski atrodas uz Base Sepolia, lietotājam maksa un bilance IR Base tīkla ETH.
    // Lai lietotājam nebūtu apjukuma, mēs tekstā skaidri norādām "Base (ETH)", bet, ja vēlies parādīt arī izvēlētās ķēdes marķieri, mēs to izdarām šādi:
    if (balanceWei >= mintPriceWei) {
      balanceDisplay.textContent = `✅ Base: ${balanceEth} ETH (enough to mint) | Network: ${vizTokenSymbol}`;
      balanceDisplay.className = 'balance-display sufficient';
    } else {
      balanceDisplay.textContent = `⚠️ Base: ${balanceEth} ETH (need ${mintPriceEth} ETH to mint) | Network: ${vizTokenSymbol}`;
      balanceDisplay.className = 'balance-display insufficient';
    }
  } catch (error) {
    console.error("Balance check failed:", error);
    balanceDisplay.textContent = `❌ Unable to check balance. Please refresh.`;
    balanceDisplay.className = 'balance-display insufficient';
  }
}

export async function connectWallet(app) {
  setButtonLoading(UI.connectBtn, true);
  showProgress();
  
  try {
    if (!window.ethereum) {
      alert('Please install a wallet like MetaMask, Rabby, or Enkrypt to use this app.');
      return;
    }
    
    app.currentVizChain = UI.chainSelect.value;
    const vizChainConfig = VIZ_CHAINS[app.currentVizChain];
    
    if (!vizChainConfig) {
      showToast('Please select a valid blockchain network', 'warning');
      throw new Error('Invalid chain selected');
    }
    
    await switchToVizChain(vizChainConfig.chainIdHex);
    
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    const signer = await provider.getSigner();
    const account = await signer.getAddress();
    
    app.provider = provider;
    app.signer = signer;
    app.account = account;
    
    UI.accountDisplay.textContent = `Connected account: ${account}`;
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const loginSuccess = await login(signer, account);
    if (!loginSuccess) {
      showToast('🔐 You need to sign the message to continue', 'warning');
      throw new Error('Login rejected');
    }
    
    await app.renderSnapshot(app.currentVizChain);
    
    UI.recordBtn.disabled = false;
    UI.generateNFTBtn.disabled = false;
    
    const price = await getNFTPrice();
    UI.generateNFTBtn.setAttribute('data-price', price);
    
    await updateChainStatus();
    await updateBalanceDisplay(account);
    
    const tokenCount = app.tokens.filter(t => !t.isNFT).length;
    showToast(`✅ Connected to ${vizChainConfig.name}! Loaded ${app.tokens.length} assets (${tokenCount} tokens, ${app.nftCenters.length} NFTs)`, 'success');
    
  } catch (err) { 
    console.error(err);
    
    let userMessage = 'Unable to connect wallet. Please try again.';
    if (err.message && err.message.includes('User rejected')) {
      userMessage = 'You cancelled the connection. Please approve to continue.';
    } else if (err.message && err.message.includes('Login rejected')) {
      userMessage = 'You need to sign the message to access your wallet data.';
    } else if (err.message && err.message.includes('Already processing')) {
      userMessage = 'Please wait, wallet is busy. Try again in a moment.';
    }
    
    showToast(userMessage, 'error');
    
    if (err.message && (err.message.includes('User rejected') || err.message.includes('Login rejected'))) {
      app.provider = null;
      app.signer = null;
      app.account = null;
      if (UI.accountDisplay) UI.accountDisplay.textContent = 'Connected account: —';
    }
  } finally { 
    setButtonLoading(UI.connectBtn, false); 
    hideProgress(); 
  }
}
