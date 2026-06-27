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
// PALĪGFUNKCIJAS
// ============================================

async function createImageBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to create image'));
    }, 'image/png');
  });
}

async function createVideoBlob(canvas) {
  const stream = canvas.captureStream(30);
  
  return new Promise((resolve, reject) => {
    let mimeType = 'video/webm';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/mp4';
    
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    
    recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.onerror = (event) => reject(event?.error || new Error('Recording failed'));
    
    recorder.start(1000);
    setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 15000);
  });
}

function createMediaFiles(imageBlob, videoBlob) {
  const imageFileName = `snapshot_${Date.now()}.png`;
  const imageFile = new File([imageBlob], imageFileName, { type: 'image/png' });
  
  const videoExt = videoBlob.type === 'video/mp4' ? 'mp4' : 'webm';
  const videoFileName = `video_${Date.now()}.${videoExt}`;
  const videoFile = new File([videoBlob], videoFileName, { type: videoBlob.type });
  
  return { imageFile, imageFileName, videoFile, videoFileName };
}

function createTempContentHash(account, imageHash, videoHash) {
  return ethers.keccak256(
    ethers.concat([
      ethers.toUtf8Bytes('WalletVisualizer'),
      imageHash,
      videoHash,
      ethers.toUtf8Bytes(account)
    ])
  );
}

async function signAntiBotMessage(signer, account) {
  const antiBotMessage = `Wallet Visualizer NFT Generation\nTimestamp: ${Date.now()}\nWallet: ${account}`;
  
  try {
    await signer.signMessage(antiBotMessage);
    return { success: true };
  } catch (signError) {
    if (signError.message?.includes('User denied') || signError.code === 'ACTION_REJECTED') {
      showToast('🛑 Cancelled by user', 'warning');
    } else {
      showToast('❌ Verification failed', 'error');
    }
    return { success: false };
  }
}

async function createMediaFilesWithHashes(canvas) {
  const imageBlob = await createImageBlob(canvas);
  const videoBlob = await createVideoBlob(canvas);
  
  const { imageFile, imageFileName, videoFile, videoFileName } = createMediaFiles(imageBlob, videoBlob);
  const imageHash = await calculateHashFromBlob(imageBlob);
  const videoHash = await calculateHashFromBlob(videoBlob);
  
  return { imageBlob, videoBlob, imageFile, imageFileName, videoFile, videoFileName, imageHash, videoHash };
}

async function switchToMintChainAndAuth(app) {
  showToast('🔄 Switching to Base...', 'info');
  await switchToMintChain();
  await new Promise(resolve => setTimeout(resolve, 400));
  
  app.provider = new ethers.BrowserProvider(window.ethereum);
  app.signer = await app.provider.getSigner();
  app.account = await app.signer.getAddress();
  
  const loginSuccess = await login(app.signer, app.account);
  if (!loginSuccess) {
    showToast('🔐 Authentication failed. Please reconnect your wallet.', 'error');
    return false;
  }
  
  const contractAddress = await getContractAddress();
  if (contractAddress) {
    try {
      const stableProvider = await getMintProvider();
      const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, stableProvider);
      const priceWei = await contract.mintPrice();
      UI.generateNFTBtn.dataset.price = ethers.formatEther(priceWei);
    } catch(e) {
      console.warn("Could not fetch price on mint chain:", e);
    }
  }
  
  return true;
}

async function performRequestMint(account, imageHash, videoHash, tempContentHash, signer) {
  const requestRes = await apiFetch('/api/request-mint', {
    method: 'POST',
    body: JSON.stringify({ wallet: account, imageHash, videoHash, contentHash: tempContentHash })
  });
  
  const requestData = await requestRes.json();
  if (!requestData.success) throw new Error(requestData.error || 'Mint request failed');
  
  const txValue = BigInt(requestData.transaction.value);
  const txGasLimit = BigInt(requestData.transaction.gasLimit);
  
  showToast('✍️ Please sign the transaction in your wallet...', 'info');
  const tx = await signer.sendTransaction({
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

async function uploadFilesToArweave(imageFile, videoFile) {
  const nftFormData = new FormData();
  nftFormData.append('image', imageFile);
  nftFormData.append('video', videoFile);
  
  const authToken = localStorage.getItem("auth_token");
  const reqHeaders = authToken ? { "Authorization": `Bearer ${authToken}` } : {};
  
  const serverRes = await fetch('/api/prepare-nft', {
    method: 'POST', headers: reqHeaders, body: nftFormData
  });
  
  if (!serverRes.ok) {
    throw new Error('Arweave upload failed. Your deposit will be refunded automatically.');
  }
  
  const serverData = await serverRes.json();
  if (!serverData.success) throw new Error(serverData.error || 'Arweave processing failed');
  
  return serverData;
}

function buildMetadata(app, imageFileName, videoFileName, tokenList, nftList, snapshotData) {
  const currentChainConfig = VIZ_CHAINS[app.currentVizChain];
  const isAmoy = app.currentVizChain === 'polygonAmoy' || currentChainConfig?.chainIdHex?.toLowerCase() === '0x13882';
  const nativeTokenSymbol = isAmoy ? 'POL' : (currentChainConfig?.nativeCurrency || 'ETH');
  
  return {
    name: "Wallet Visualization NFT",
    description: `Generated from wallet ${app.account} on ${new Date().toISOString()}. Stored permanently on Arweave.`,
    image: imageFileName,
    animation_url: videoFileName,
    attributes: [
      { trait_type: "Balance Amount", value: snapshotData.ethBalance },
      { trait_type: "Native Token", value: nativeTokenSymbol },
      { trait_type: "Token Count", value: snapshotData.tokenCount },
      { trait_type: "NFT Count", value: snapshotData.nftCount },
      { trait_type: "Transaction Count", value: snapshotData.txCount },
      { trait_type: "Visual Style", value: ADDON_STYLES[app.currentAddonStyle]?.name || app.currentAddonStyle },
      { trait_type: "Source Chain", value: app.currentVizChain },
      { trait_type: "Storage", value: "Arweave (Permanent)" },
      { trait_type: "Generated At", value: new Date().toISOString() }
    ],
    tokens: tokenList,
    nfts: nftList
  };
}

async function finalizeOnChain(account, metadataUri, storageCostWei, finalContentHash) {
  const finalizeRes = await apiFetch('/api/finalize-mint', {
    method: 'POST',
    body: JSON.stringify({ wallet: account, metadataUri, storageCostWei, contentHash: finalContentHash })
  });
  
  const finalizeData = await finalizeRes.json();
  if (!finalizeData.success) throw new Error(finalizeData.error || 'Finalize failed');
  
  showToast('✅ NFT finalized on blockchain!', 'success');
}

async function saveLocalFiles(imageBlob, videoBlob, metadata) {
  const metadataString = JSON.stringify(metadata, null, 2);
  const metadataBlob = new Blob([metadataString], { type: 'application/json' });
  const metadataFileName = `metadata_${Date.now()}.json`;
  
  await downloadAllFiles([
    { blob: imageBlob, filename: metadata.image },
    { blob: metadataBlob, filename: metadataFileName },
    { blob: videoBlob, filename: metadata.animation_url }
  ]);
  showToast('✅ All files saved as ZIP!', 'success');
}

async function restoreVisualization(app) {
  showToast('🔄 Refreshing view...', 'info');
  await switchToVizChain(VIZ_CHAINS[app.currentVizChain].chainIdHex);
  await new Promise(resolve => setTimeout(resolve, 500));
  app.provider = new ethers.BrowserProvider(window.ethereum);
  app.signer = await app.provider.getSigner();
  app.account = await app.signer.getAddress();
  await app.renderSnapshot(app.currentVizChain);
}

function handleNFTError(error) {
  if (error.message?.includes('User denied') || error.code === 'ACTION_REJECTED') {
    return '🛑 Transaction was cancelled in your wallet.';
  }
  if (error.message?.includes('insufficient funds')) {
    return '💰 Insufficient funds. Please add ETH to your wallet and try again.';
  }
  return 'Something went wrong. Please try again.';
}

function showSuccessAlert(tx, txValue, imageHash, videoHash, finalContentHash, metaId, serverData, storageCostEth) {
  const arweaveSuccess = serverData.arweave?.success || false;
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
}

async function generateNFTSteps(app) {
  // Step 1: Anti-bot
  showToast('✍️ Sign to continue...', 'info');
  const { success: verified } = await signAntiBotMessage(app.signer, app.account);
  if (!verified) return null;

  // Step 2: Create media
  showToast('📸 Creating your NFT files...', 'info');
  const mediaData = await createMediaFilesWithHashes(UI.canvas);
  showToast('🎬 Video recorded!', 'success');
  
  // Step 3: Prepare hashes
  const tempContentHash = createTempContentHash(app.account, mediaData.imageHash, mediaData.videoHash);

  // Step 4: Switch to mint chain
  const switched = await switchToMintChainAndAuth(app);
  if (!switched) return null;

  // Step 5: Request mint
  showToast('📝 Requesting mint reservation...', 'info');
  const { tx, txValue, requestData } = await performRequestMint(
    app.account, mediaData.imageHash, mediaData.videoHash, tempContentHash, app.signer
  );

  // Step 6: Upload to Arweave
  showToast('📤 Uploading to Arweave...', 'info');
  const serverData = await uploadFilesToArweave(mediaData.imageFile, mediaData.videoFile);
  console.log('✅ Server processed:', serverData);

  // Step 7: Build metadata
  const tokenList = app.tokens.filter(t => !t.isNFT).map(t => ({
    symbol: t.symbol, address: t.address, balance: t.balance
  }));
  const nftList = app.tokens.filter(t => t.isNFT).map(n => ({
    symbol: n.symbol, address: n.address, tokenId: n.tokenId
  }));

  const snapshotData = {
    ethBalance: app.ethBalance?.toString() || "0",
    txCount: app.txCount?.toString() || "0",
    tokenCount: tokenList.length.toString(),
    nftCount: nftList.length.toString()
  };

  const metadata = buildMetadata(app, mediaData.imageFileName, mediaData.videoFileName, tokenList, nftList, snapshotData);
  const metadataString = JSON.stringify(metadata, null, 2);
  const finalContentHash = await calculateHashFromBlob(new Blob([metadataString]));

  // Step 8: Upload metadata
  let metaId;
  try {
    const metaRes = await uploadMetadataToArweave(metadata);
    metaId = metaRes.id || metaRes.cid;
    showToast('✅ Metadata uploaded to Arweave!', 'success');
  } catch (metaError) {
    console.error('Metadata upload failed:', metaError);
    showToast('❌ Failed to upload metadata. Deposit will be refunded automatically.', 'error');
    return null;
  }

  // Step 9: Finalize
  const metadataUri = `${ARWEAVE_GATEWAY}${metaId}`;
  const storageCostWei = serverData.storage?.costWei || "0";
  const storageCostEth = serverData.storage?.costEth || "0";

  try {
    await finalizeOnChain(app.account, metadataUri, storageCostWei, finalContentHash);
  } catch (finalizeError) {
    console.error('Finalize failed:', finalizeError);
    showToast('❌ Finalize failed. Refund will be processed automatically.', 'error');
  }

  // Step 10: Save & alert
  showToast('💾 Saving all files as ZIP...', 'info');
  await saveLocalFiles(mediaData.imageBlob, mediaData.videoBlob, metadata);
  showToast('✅ All files saved as ZIP!', 'success');
  
  showSuccessAlert(tx, txValue, mediaData.imageHash, mediaData.videoHash, finalContentHash, metaId, serverData, storageCostEth);

  return true;
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
    showWarning('⚠️ Do not close this tab until minting is complete!', true);

    const previousShowInfo = this.showInfo;
    this.showInfo = false;
    
    try {
      const result = await generateNFTSteps(this);
      
      if (result === null) {
        showWarning('', false);
        return;
      }
      
      await restoreVisualization(this);
      
    } catch (error) {
      console.error(error);
      const userMessage = handleNFTError(error);
      
      showToast('❌ ' + userMessage, 'error');
      showWarning('', false);
      alert(userMessage);
      
      try {
        await restoreVisualization(this);
      } catch (restoreErr) {
        console.warn('Could not restore visualization:', restoreErr);
      }
    } finally { 
      this.showInfo = previousShowInfo;
      setButtonLoading(UI.generateNFTBtn, false);
    }
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
