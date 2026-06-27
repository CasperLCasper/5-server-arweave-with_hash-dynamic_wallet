// ============================================ //
// MAIN APP - MULTICHAIN WALLET VISUALIZER
// Arweave/Turbo Storage + Base Sepolia Minting
// DIVPAKĀPJU MINTĒŠANA: vispirms maksā, tad upload
// ============================================ //

import { AppState, initUI, UI } from './modules/state.js';
import { VIZ_CHAINS, MINT_CHAIN } from './modules/chains.js';
import { ARWEAVE_GATEWAY, CONTRACT_ABI, LOW_POWER_MODE, getMintProvider } from './modules/config.js'; 
import { showToast, showWarning, setButtonLoading, updateTokenListUI, hideProgress, showProgress } from './modules/ui.js';
import { login, getNFTPrice, getContractAddress } from './modules/api.js'; 
import { connectWallet, updateChainStatus, switchToMintChain, switchToVizChain } from './modules/web3.js';
import { 
  uploadMetadataToArweave,
  showArweavePreview, downloadFile, downloadAllFiles, calculateHashFromBlob 
} from './modules/storage.js';
import { startRecording, cleanupRecording } from './modules/recording.js';
import { getCanvasDimensions, resizeCanvas, cleanup, drawFrame, animate, stopAnimation, renderSnapshot, updateNFTCenters, initParticlesOnce, cloneParticles, hashStringToInt, seededRandomFloat, createParticleCache } from './modules/visualizer.js';
import { apiFetch } from './modules/api.js';

import { ADDON_STYLES } from './themes.js';

import { MAINTENANCE_CONFIG } from './maintenance.js';

// ============================================
// PALĪGFUNKCIJAS executeNFTMinting
// ============================================

async function createImageFromCanvas() {
  return new Promise((resolve, reject) => {
    UI.canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to create image'));
    }, 'image/png');
  });
}

async function createVideoFromCanvas() {
  const stream = UI.canvas.captureStream(30);
  return new Promise((resolve, reject) => {
    let mimeType = 'video/webm';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/mp4';
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.onerror = (event) => reject(event?.error || new Error('Recording failed'));
    
    recorder.start(1000);
    setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 15000);
  });
}

async function prepareMediaFiles(app, previousShowInfo) {
  showToast('📸 Creating your NFT files...', 'info');
  
  let imageBlob;
  try {
    imageBlob = await createImageFromCanvas();
  } catch (imageError) {
    console.error('Image creation failed:', imageError);
    showToast('❌ Failed to create image. Cannot mint NFT.', 'error');
    showWarning('', false);
    app.showInfo = previousShowInfo;
    setButtonLoading(UI.generateNFTBtn, false);
    return null;
  }
  
  const imageFileName = `snapshot_${Date.now()}.png`;
  const imageFile = new File([imageBlob], imageFileName, { type: 'image/png' });
  const imageHash = await calculateHashFromBlob(imageBlob);
  
  let videoBlob;
  let videoFileName;
  let videoFile;
  let videoHash;
  
  try {
    videoBlob = await createVideoFromCanvas();
    const videoExt = videoBlob.type === 'video/mp4' ? 'mp4' : 'webm';
    videoFileName = `video_${Date.now()}.${videoExt}`;
    videoFile = new File([videoBlob], videoFileName, { type: videoBlob.type });
    videoHash = await calculateHashFromBlob(videoBlob);
    showToast('🎬 Video recorded!', 'success');
  } catch (videoError) {
    console.error('Video recording failed:', videoError);
    showToast('❌ Failed to record video. Cannot mint NFT.', 'error');
    showWarning('', false);
    app.showInfo = previousShowInfo;
    setButtonLoading(UI.generateNFTBtn, false);
    return null;
  }
  
  app.showInfo = previousShowInfo;
  
  return { imageBlob, imageFile, imageFileName, imageHash, videoBlob, videoFile, videoFileName, videoHash };
}

async function switchToBaseAndAuthenticate(app) {
  showToast('🔄 Switching to Base...', 'info');
  await switchToMintChain();
  await new Promise(resolve => setTimeout(resolve, 400));
  
  app.provider = new ethers.BrowserProvider(window.ethereum);
  app.signer = await app.provider.getSigner();
  app.account = await app.signer.getAddress();
  
  const loginSuccess = await login(app.signer, app.account);
  if (!loginSuccess) {
    showToast('🔐 Authentication failed. Please reconnect your wallet.', 'error');
    showWarning('', false);
    setButtonLoading(UI.generateNFTBtn, false);
    await switchToVizChain(VIZ_CHAINS[app.currentVizChain].chainIdHex);
    await new Promise(resolve => setTimeout(resolve, 500));
    app.provider = new ethers.BrowserProvider(window.ethereum);
    app.signer = await app.provider.getSigner();
    app.account = await app.signer.getAddress();
    await app.renderSnapshot(app.currentVizChain);
    return false;
  }
  
  const contractAddress = await getContractAddress();
  if (contractAddress) {
    try {
      const stableProvider = await getMintProvider();
      const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, stableProvider);
      const priceWei = await contract.mintPrice();
      const mintPriceEth = ethers.formatEther(priceWei);
      UI.generateNFTBtn.dataset.price = mintPriceEth;
    } catch(e) {
      console.warn("Could not fetch price on mint chain:", e);
    }
  }
  
  return true;
}

async function sendMintTransaction(app, imageHash, videoHash, tempContentHash) {
  let requestData;
  try {
    const requestRes = await apiFetch('/api/request-mint', {
      method: 'POST',
      body: JSON.stringify({
        wallet: app.account,
        imageHash: imageHash,
        videoHash: videoHash,
        contentHash: tempContentHash
      })
    });
    requestData = await requestRes.json();
  } catch (apiError) {
    console.error("Request mint API error:", apiError);
    throw new Error(`Mint request failed: ${apiError.message}`);
  }
  
  if (!requestData.success) throw new Error(requestData.error || 'Mint request failed');
  
  const txValue = BigInt(requestData.transaction.value);
  const txGasLimit = BigInt(requestData.transaction.gasLimit);
  
  showToast('✍️ Please sign the transaction in your wallet...', 'info');
  const tx = await app.signer.sendTransaction({
    to: requestData.transaction.to,
    data: requestData.transaction.data,
    value: txValue,
    gasLimit: txGasLimit
  });
  
  showToast('⏳ Waiting for deposit confirmation...', 'info');
  await tx.wait();
  showToast('✅ Deposit confirmed!', 'success');
  
  return { tx, txValue, requestData };
}

async function uploadToArweaveAndCreateMetadata(app, imageFile, videoFile, imageHash, videoHash, videoBlob, imageFileName, videoFileName, snapshotEthBalance, snapshotTxCount, snapshotTokenCount, snapshotNftCount, nativeTokenSymbol, tokenList, nftList) {
  showToast('📤 Uploading to Arweave...', 'info');
  
  const nftFormData = new FormData();
  nftFormData.append('image', imageFile);
  nftFormData.append('video', videoFile);
  
  const authToken = localStorage.getItem("auth_token");
  const reqHeaders = authToken ? { "Authorization": `Bearer ${authToken}` } : {};
  
  let serverData;
  try {
    const serverRes = await fetch('/api/prepare-nft', {
      method: 'POST',
      headers: reqHeaders,
      body: nftFormData
    });
    
    if (!serverRes.ok) {
      console.error('Upload failed — refund will be processed automatically');
      throw new Error(`Arweave upload failed. Your deposit will be refunded automatically.`);
    }
    
    serverData = await serverRes.json();
    if (!serverData.success) throw new Error(serverData.error || 'Arweave processing failed');
  } catch (uploadError) {
    console.error('Upload error:', uploadError);
    showToast('❌ ' + uploadError.message, 'error');
    showWarning('', false);
    setButtonLoading(UI.generateNFTBtn, false);
    return null;
  }
  
  console.log('✅ Server processed:', serverData);
  
  const gw = ARWEAVE_GATEWAY;
  const imageUrl = serverData.image.id ? `${gw}${serverData.image.id}` : `local://${imageHash}`;
  const arweaveSuccess = serverData.arweave?.success || false;
  const storageCostWei = serverData.storage?.costWei || "0";
  const storageCostEth = serverData.storage?.costEth || "0";
  
  const localMetadata = {
    name: "Wallet Visualization NFT",
    description: `Generated from wallet ${app.account} on ${new Date().toISOString()}. Stored permanently on Arweave.`,
    image: imageFileName,
    animation_url: videoFileName,
    attributes: [
      { trait_type: "Balance Amount", value: snapshotEthBalance },
      { trait_type: "Native Token", value: nativeTokenSymbol },
      { trait_type: "Token Count", value: snapshotTokenCount },
      { trait_type: "NFT Count", value: snapshotNftCount },
      { trait_type: "Transaction Count", value: snapshotTxCount },
      { trait_type: "Visual Style", value: ADDON_STYLES[app.currentAddonStyle]?.name || app.currentAddonStyle },
      { trait_type: "Source Chain", value: app.currentVizChain },
      { trait_type: "Storage", value: "Arweave (Permanent)" },
      { trait_type: "Generated At", value: new Date().toISOString() }
    ],
    tokens: tokenList,
    nfts: nftList
  };

  if (!videoBlob) delete localMetadata.animation_url;

  const localMetadataString = JSON.stringify(localMetadata, null, 2);
  const finalContentHash = await calculateHashFromBlob(new Blob([localMetadataString]));
  
  const arweaveMetadata = {
    ...localMetadata,
    image: imageUrl,
    animation_url: serverData.video?.id ? `${gw}${serverData.video.id}` : undefined
  };
  if (!arweaveMetadata.animation_url) delete arweaveMetadata.animation_url;
  
  let metaId;
  try {
    const metaRes = await uploadMetadataToArweave(arweaveMetadata);
    metaId = metaRes.id || metaRes.cid;
    showToast('✅ Metadata uploaded to Arweave!', 'success');
  } catch (metaError) {
    console.error('Metadata upload failed:', metaError);
    showToast('❌ Failed to upload metadata. Deposit will be refunded automatically.', 'error');
    showWarning('', false);
    setButtonLoading(UI.generateNFTBtn, false);
    return null;
  }
  
  return { serverData, localMetadataString, finalContentHash, metaId, arweaveSuccess, storageCostWei, storageCostEth };
}

async function finalizeAndDownload(app, metaId, finalContentHash, storageCostWei, imageBlob, videoBlob, imageFileName, videoFileName, localMetadataString) {
  const metadataUri = `${ARWEAVE_GATEWAY}${metaId}`;
  
  showToast('🔒 Finalizing your NFT on blockchain...', 'info');
  
  try {
    const finalizeRes = await apiFetch('/api/finalize-mint', {
      method: 'POST',
      body: JSON.stringify({
        wallet: app.account,
        metadataUri: metadataUri,
        storageCostWei: storageCostWei,
        contentHash: finalContentHash
      })
    });
    const finalizeData = await finalizeRes.json();
    if (!finalizeData.success) throw new Error(finalizeData.error || 'Finalize failed');
    showToast('✅ NFT finalized on blockchain!', 'success');
  } catch (finalizeError) {
    console.error('Finalize failed:', finalizeError);
    showToast('❌ Finalize failed. Refund will be processed automatically.', 'error');
  }
  
  const metadataBlob = new Blob([localMetadataString], { type: 'application/json' });
  const metadataFileName = `metadata_${Date.now()}.json`;
  
  showToast('💾 Saving all files as ZIP...', 'info');
  
  const completeFiles = [
    { blob: imageBlob, filename: imageFileName },
    { blob: metadataBlob, filename: metadataFileName },
    { blob: videoBlob, filename: videoFileName }
  ];
  await downloadAllFiles(completeFiles);
  showToast('✅ All files saved as ZIP!', 'success');
  
  showWarning('', false);
}

async function executeNFTMinting(app, snapshotEthBalance, snapshotTxCount, snapshotTokenCount, snapshotNftCount, nativeTokenSymbol, tokenList, nftList, previousShowInfo) {
  try {
    showToast('✍️ Sign to continue...', 'info');
    const antiBotMessage = `Wallet Visualizer NFT Generation\nTimestamp: ${Date.now()}\nWallet: ${app.account}`;
    
    try {
      await app.signer.signMessage(antiBotMessage);
    } catch (signError) {
      if (signError.message?.includes('User denied') || signError.code === 'ACTION_REJECTED') {
        showToast('🛑 Cancelled by user', 'warning');
      } else {
        showToast('❌ Verification failed', 'error');
      }
      showWarning('', false);
      app.showInfo = previousShowInfo;
      setButtonLoading(UI.generateNFTBtn, false);
      return;
    }
    
    const media = await prepareMediaFiles(app, previousShowInfo);
    if (!media) return;
    
    const { imageBlob, imageFile, imageFileName, imageHash, videoBlob, videoFile, videoFileName, videoHash } = media;
    
    const tempContentHash = ethers.keccak256(
      ethers.concat([
        ethers.toUtf8Bytes('WalletVisualizer'),
        imageHash, videoHash, ethers.toUtf8Bytes(app.account)
      ])
    );
    
    const authenticated = await switchToBaseAndAuthenticate(app);
    if (!authenticated) return;
    
    showToast('📝 Requesting mint reservation...', 'info');
    const { tx, txValue } = await sendMintTransaction(app, imageHash, videoHash, tempContentHash);
    
    const uploadResult = await uploadToArweaveAndCreateMetadata(
      app, imageFile, videoFile, imageHash, videoHash, videoBlob,
      imageFileName, videoFileName, snapshotEthBalance, snapshotTxCount,
      snapshotTokenCount, snapshotNftCount, nativeTokenSymbol, tokenList, nftList
    );
    if (!uploadResult) return;
    
    const { serverData, localMetadataString, finalContentHash, metaId, arweaveSuccess, storageCostWei, storageCostEth } = uploadResult;
    
    await finalizeAndDownload(app, metaId, finalContentHash, storageCostWei, imageBlob, videoBlob, imageFileName, videoFileName, localMetadataString);
    
    const arweaveStatus = arweaveSuccess ? '✅' : '⚠️';
    alert(`✅ NFT minted!\n\n` +
      `Tx: ${tx.hash}\n` +
      `Price: ${ethers.formatEther(txValue)} ETH\n` +
      `(Storage: ${storageCostEth} ETH)\n\n` +
      `🔐 Image Hash: ${imageHash}\n` +
      `🔐 Video Hash: ${videoHash}\n` +
      `🔐 Content Hash (Basescan & ZIP): ${finalContentHash}\n` +
      `${metaId ? '📄 Arweave Metadata: ' + metaId + '\n' : ''}` +
      `${serverData.image?.id ? '🖼️ Arweave Image: ' + serverData.image.id + '\n' : ''}` +
      `${serverData.video?.id ? '🎬 Arweave Video: ' + serverData.video.id + '\n' : ''}` +
      `\n${arweaveStatus} Arweave: ${arweaveSuccess ? 'OK' : 'Failed (files saved locally)'}` +
      `\n\n💾 All files saved as nft_assets_*.zip`);
    
    showToast('🔄 Refreshing view...', 'info');
    await switchToVizChain(VIZ_CHAINS[app.currentVizChain].chainIdHex);
    await new Promise(resolve => setTimeout(resolve, 500));
    app.provider = new ethers.BrowserProvider(window.ethereum);
    app.signer = await app.provider.getSigner();
    app.account = await app.signer.getAddress();
    await app.renderSnapshot(app.currentVizChain);
    
  } catch (error) {
    console.error(error);
    let userMessage = 'Something went wrong. Please try again.';
    
    if (error.message?.includes('User denied') || error.code === 'ACTION_REJECTED') {
      userMessage = '🛑 Transaction was cancelled in your wallet.';
    } else if (error.message?.includes('insufficient funds')) {
      userMessage = '💰 Insufficient funds. Please add ETH to your wallet and try again.';
    } else if (error.message?.includes('deposit has been refunded') || error.message?.includes('refunded automatically')) {
      userMessage = '📤 Upload failed. Your deposit will be refunded automatically.';
    }
    
    showToast('❌ ' + userMessage, 'error');
    showWarning('', false);
    alert(userMessage);
    
    try {
      await switchToVizChain(VIZ_CHAINS[app.currentVizChain].chainIdHex);
      await new Promise(resolve => setTimeout(resolve, 500));
      app.provider = new ethers.BrowserProvider(window.ethereum);
      app.signer = await app.provider.getSigner();
      app.account = await app.signer.getAddress();
      await app.renderSnapshot(app.currentVizChain);
    } catch (restoreErr) {
      console.warn('Could not restore visualization:', restoreErr);
    }
  }
}

// ============================================
// GALVENĀ APLIKĀCIJA
// ============================================

const App = Object.assign({}, AppState, {
  setAddonStyle(styleName) {
    if (MAINTENANCE_CONFIG.isMaintenance) return;
    this.currentAddonStyle = styleName;
    
    const style = ADDON_STYLES[styleName];
    if (!style) return;

    UI.styleIndicator.style.borderLeftColor = style.color;
    UI.indicatorText.innerHTML = style.indicatorText;
    UI.styleIndicator.style.transform = 'scale(1.05)';
    setTimeout(() => { UI.styleIndicator.style.transform = 'scale(1)'; }, 300);
  },

  resetApp() {
    console.log("🔄 Resetting app data after network change...");
    
    stopAnimation(this);
    
    if (this.ctx) {
      this.ctx.clearRect(0, 0, UI.canvas.width, UI.canvas.height);
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, UI.canvas.width, UI.canvas.height);
    }
    
    this.tokens = [];
    this.ethBalance = 0;
    this.txCount = 0;
    this.particles = [];
    this.initialParticles = [];
    this.nftCenters = [];
    this.particleCache.clear();
    
    this.account = null;
    this.provider = null;
    this.signer = null;
    
    if (UI.accountDisplay) UI.accountDisplay.textContent = 'Connected account: —';
    if (UI.recordTimer) UI.recordTimer.textContent = 'Recording: 0 / 15 s';
    if (UI.statusMsg) UI.statusMsg.textContent = '';
    if (UI.tokenListContainer) UI.tokenListContainer.style.display = 'none';
    if (UI.tokenListContent) UI.tokenListContent.innerHTML = '';
    
    if (UI.recordBtn) UI.recordBtn.disabled = true;
    if (UI.renderBtn) UI.renderBtn.disabled = true;
    if (UI.generateNFTBtn) {
      UI.generateNFTBtn.disabled = true;
      UI.generateNFTBtn.dataset.price = '';
    }
    
    updateChainStatus();
    
    console.log("✅ App data cleared. Auth token preserved.");
  },

  handleSessionExpired() {
    console.log("Session expired, cleaning up...");
    showToast('⏰ Session expired. Please reconnect your wallet.', 'warning');
    
    if (this.ctx) {
      this.ctx.clearRect(0, 0, UI.canvas.width, UI.canvas.height);
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, UI.canvas.width, UI.canvas.height);
    }
    
    this.tokens = [];
    this.ethBalance = 0;
    this.txCount = 0;
    this.particles = [];
    this.initialParticles = [];
    this.nftCenters = [];
    this.particleCache.clear();
    
    this.account = null;
    this.provider = null;
    this.signer = null;
    
    if (UI.accountDisplay) UI.accountDisplay.textContent = 'Connected account: —';
    if (UI.tokenListContainer) UI.tokenListContainer.style.display = 'none';
    if (UI.tokenListContent) UI.tokenListContent.innerHTML = '';
    
    if (UI.recordBtn) UI.recordBtn.disabled = true;
    if (UI.renderBtn) UI.renderBtn.disabled = true;
    if (UI.generateNFTBtn) {
      UI.generateNFTBtn.disabled = true;
      UI.generateNFTBtn.dataset.price = '';
    }
    
    showToast('⏰ Session expired. Please click "Connect Wallet" to reconnect.', 'warning');
  },

  async generateNFT() {
    if (MAINTENANCE_CONFIG.isMaintenance) {
      showToast('🛠️ Minting is disabled during maintenance.', 'warning');
      return;
    }

    if (!this.account || !this.provider || !this.signer) { 
      showToast('🔌 Please connect your wallet first', 'warning');
      return; 
    }
    
    setButtonLoading(UI.generateNFTBtn, true);
    showWarning('⚠️ Do not close this tab until minting is complete and you have saved the ZIP file with your NFT files!', true);

    const snapshotEthBalance = this.ethBalance ? this.ethBalance.toString() : "0";
    const snapshotTxCount = this.txCount ? this.txCount.toString() : "0";
    const snapshotTokenCount = this.tokens ? this.tokens.filter(t => !t.isNFT).length.toString() : "0";
    const snapshotNftCount = this.tokens ? this.tokens.filter(t => t.isNFT).length.toString() : "0";
    
    const currentChainConfig = VIZ_CHAINS[this.currentVizChain];
    const isAmoy = this.currentVizChain === 'polygonAmoy' || currentChainConfig?.chainIdHex?.toLowerCase() === '0x13882';
    const nativeTokenSymbol = isAmoy ? 'POL' : (currentChainConfig?.nativeCurrency || 'ETH');
    
    const tokenList = this.tokens.filter(t => !t.isNFT).map(t => ({
      symbol: t.symbol,
      address: t.address,
      balance: t.balance
    }));
    
    const nftList = this.tokens.filter(t => t.isNFT).map(n => ({
      symbol: n.symbol,
      address: n.address,
      tokenId: n.tokenId
    }));

    const previousShowInfo = this.showInfo;
    this.showInfo = false;
    
    await executeNFTMinting(this, snapshotEthBalance, snapshotTxCount, snapshotTokenCount, snapshotNftCount, nativeTokenSymbol, tokenList, nftList, previousShowInfo);
  },

  async renderSnapshot(chain) {
    if (MAINTENANCE_CONFIG.isMaintenance) return;
    await renderSnapshot(this, chain);
    
    if (UI.recordBtn) UI.recordBtn.disabled = false;
    if (UI.renderBtn) UI.renderBtn.disabled = false;
    if (UI.generateNFTBtn) {
      const price = await getNFTPrice();
      UI.generateNFTBtn.dataset.price = price;
    }
  },

  cleanupUI() {
    if (this.ctx) {
      this.ctx.clearRect(0, 0, UI.canvas.width, UI.canvas.height);
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, UI.canvas.width, UI.canvas.height);
    }
    this.tokens = [];
    this.ethBalance = 0;
    this.txCount = 0;
    this.particles = [];
    this.initialParticles = [];
    this.nftCenters = [];
    this.particleCache.clear();
    
    if (UI.tokenListContainer) UI.tokenListContainer.style.display = 'none';
    if (UI.tokenListContent) UI.tokenListContent.innerHTML = '';
    if (UI.accountDisplay) UI.accountDisplay.textContent = 'Connected account: —';
    
    if (UI.recordBtn) UI.recordBtn.disabled = true;
    if (UI.renderBtn) UI.renderBtn.disabled = true;
    if (UI.generateNFTBtn) {
      UI.generateNFTBtn.disabled = true;
      UI.generateNFTBtn.dataset.price = '';
    }
  },

  renderMaintenanceScreen() {
    stopAnimation(this);
    if (this.ctx || UI.canvas) {
      this.ctx = this.ctx || UI.canvas.getContext('2d');
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, UI.canvas.width, UI.canvas.height);
      
      this.ctx.fillStyle = '#ff3333';
      this.ctx.font = 'bold 28px Inter, sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(MAINTENANCE_CONFIG.title, UI.canvas.width / 2, UI.canvas.height / 2 - 15);
      
      this.ctx.fillStyle = '#aaa';
      this.ctx.font = '16px Inter, sans-serif';
      this.ctx.fillText(MAINTENANCE_CONFIG.subtitle, UI.canvas.width / 2, UI.canvas.height / 2 + 30);
    }

    if (UI.connectBtn) {
      UI.connectBtn.disabled = true;
      UI.connectBtn.textContent = '🛠️ Maintenance Active';
    }
    if (UI.renderBtn) UI.renderBtn.disabled = true;
    if (UI.generateNFTBtn) UI.generateNFTBtn.disabled = true;
    if (UI.recordBtn) UI.recordBtn.disabled = true;
    if (UI.chainSelect) UI.chainSelect.disabled = true;
  },

  init() {
    console.log("🚀 Starting Wallet Visualizer with Arweave Permanent Storage...");
    initUI();
    resizeCanvas(this);
    
    if (MAINTENANCE_CONFIG.isMaintenance) {
      console.warn("⚠️ Application initialization stopped: Maintenance Mode is active.");
      this.renderMaintenanceScreen();
      window.addEventListener('resize', () => {
        resizeCanvas(this);
        this.renderMaintenanceScreen();
      });
      showToast('🛠️ System is undergoing planned maintenance.', 'warning');
      return; 
    }

    window.addEventListener('auth:expired', () => {
      this.handleSessionExpired();
    });
    
    UI.connectBtn.addEventListener('click', async () => {
      this.tokens = [];
      this.ethBalance = 0;
      this.txCount = 0;
      this.particles = [];
      this.initialParticles = [];
      this.nftCenters = [];
      this.particleCache.clear();
      
      if (UI.tokenListContent) UI.tokenListContent.innerHTML = '';
      
      await connectWallet(this);
    });
    
    UI.renderBtn.addEventListener('click', () => this.renderSnapshot(this.currentVizChain));
    UI.generateNFTBtn.addEventListener('click', () => this.generateNFT());
    UI.recordBtn.addEventListener('click', () => startRecording(this));
    
    UI.chainSelect.addEventListener('change', async () => {
      if (this.account) {
        showToast(`You changed the network! Please reconnect wallet to switch to ${UI.chainSelect.value}`, 'info');
      }
    });
    
    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.setAddonStyle(btn.dataset.theme);
      });
    });
    
    UI.fullscreenIcon.addEventListener('click', () => { 
      if (!document.fullscreenElement) UI.canvas.requestFullscreen().catch(() => {}); 
      else document.exitFullscreen().catch(() => {}); 
    });
    
    UI.toggleInfoIcon.addEventListener('click', () => { 
      this.showInfo = !this.showInfo; 
      if (UI.tokenListContainer) {
        UI.tokenListContainer.style.display = this.showInfo ? 'block' : 'none'; 
      }
      if (this.showInfo) updateTokenListUI(this.tokens); 
    });

    const modal = document.getElementById("aboutModal");
    const aboutBtn = document.getElementById("aboutBtn");
    const closeBtn = document.querySelector(".close-modal");

    if (aboutBtn && modal && closeBtn) {
      aboutBtn.addEventListener("click", () => { modal.style.display = "block"; });
      closeBtn.addEventListener("click", () => { modal.style.display = "none"; });
      window.addEventListener("click", (event) => { if (event.target === modal) modal.style.display = "none"; });
    } else {
      console.warn("⚠️ About modal elements were not found in the DOM.");
    }
    
    window.addEventListener('resize', () => resizeCanvas(this));
    
    if (window.ethereum) {
      window.ethereum.on('chainChanged', () => { this.resetApp(); });
    }
    
    window.LOW_POWER_MODE = LOW_POWER_MODE;
    
    showToast('✨ Welcome! Connect your wallet to begin.', 'info');
    console.log('✅ Wallet Visualizer Ready with Arweave Permanent Storage!');
  }
});

window.App = App;
App.init();
