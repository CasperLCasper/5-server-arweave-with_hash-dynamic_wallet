// ============================================ //
// MAIN APP - MULTICHAIN WALLET VISUALIZER
// Arweave/Turbo Storage + Base Sepolia Minting
// ============================================ //

import { AppState, initUI, UI } from './modules/state.js';
import { VIZ_CHAINS, MINT_CHAIN } from './modules/chains.js';
import { ARWEAVE_GATEWAY, CONTRACT_ABI, LOW_POWER_MODE, getMintProvider } from './modules/config.js'; 
import { showToast, setButtonLoading, updateTokenListUI, hideProgress, showProgress } from './modules/ui.js';
import { login, getNFTPrice, getContractAddress } from './modules/api.js'; 
import { connectWallet, updateChainStatus, switchToMintChain, switchToVizChain } from './modules/web3.js';
import { 
  uploadImageToArweave, uploadVideoToArweave, uploadMetadataToArweave, 
  showArweavePreview, downloadFile, downloadAllFiles, calculateHashFromBlob 
} from './modules/storage.js';
import { startRecording, cleanupRecording } from './modules/recording.js';
import { getCanvasDimensions, resizeCanvas, cleanup, drawFrame, animate, stopAnimation, renderSnapshot, updateNFTCenters, initParticlesOnce, cloneParticles, hashStringToInt, seededRandomFloat, createParticleCache, resumeVisualization } from './modules/visualizer.js';
import { apiFetch } from './modules/api.js';

import { ADDON_STYLES } from './themes.js';

import { MAINTENANCE_CONFIG } from './maintenance.js';

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
      UI.generateNFTBtn.setAttribute('data-price', '');
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
      UI.generateNFTBtn.setAttribute('data-price', '');
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
    showToast('🔄 Switching to Base Sepolia network for minting...', 'info');
    
    try {
      await switchToMintChain();
      
      await new Promise(resolve => setTimeout(resolve, 400));
      
      this.provider = new ethers.BrowserProvider(window.ethereum);
      this.signer = await this.provider.getSigner();
      this.account = await this.signer.getAddress();
      
      const loginSuccess = await login(this.signer, this.account);
      if (!loginSuccess) {
        showToast('🔐 Authentication failed. Please reconnect your wallet.', 'error');
        setButtonLoading(UI.generateNFTBtn, false);
        return;
      }
      
      const contractAddress = await getContractAddress();
      let mintPriceEth = "?";
      if (contractAddress) {
        try {
          const stableProvider = await getMintProvider();
          const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, stableProvider);
          const priceWei = await contract.mintPrice();
          mintPriceEth = ethers.formatEther(priceWei);
          UI.generateNFTBtn.setAttribute('data-price', `${mintPriceEth} ETH + gas`);
        } catch(e) {
          console.warn("Could not fetch price on mint chain:", e);
        }
      }
      
      showToast('📸 Creating your NFT assets...', 'info');
      
      const imageBlob = await new Promise((resolve, reject) => {
        UI.canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Failed to create image'));
        }, 'image/png');
      });
      
      const imageFileName = `snapshot_${Date.now()}.png`;
      const imageFile = new File([imageBlob], imageFileName, { type: 'image/png' });
      
      let videoBlob = null;
      let videoFileName = null;
      let videoFile = null;
      
      try {
        const stream = UI.canvas.captureStream(30);
        videoBlob = await new Promise((resolve, reject) => {
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
        
        const videoExt = videoBlob.type === 'video/mp4' ? 'mp4' : 'webm';
        videoFileName = `video_${Date.now()}.${videoExt}`;
        videoFile = new File([videoBlob], videoFileName, { type: videoBlob.type });
        showToast('🎬 Video recorded!', 'success');
      } catch (error) {
        console.warn('Video recording failed:', error);
        showToast('🎬 Video failed, continuing without video', 'warning');
      }
      
      showToast('📤 Uploading to Arweave (Turbo)...', 'info');
      
      const nftFormData = new FormData();
      nftFormData.append('image', imageFile);
      if (videoFile) nftFormData.append('video', videoFile);
      
      const authToken = localStorage.getItem("auth_token");
      const reqHeaders = authToken ? { "Authorization": `Bearer ${authToken}` } : {};
      
      const serverRes = await fetch('/api/prepare-nft', {
        method: 'POST',
        headers: reqHeaders,
        body: nftFormData
      });
      
      if (!serverRes.ok) {
        const errText = await serverRes.text().catch(() => 'Unknown error');
        throw new Error(`Server error: ${serverRes.status} ${errText}`);
      }
      
      const serverData = await serverRes.json();
      if (!serverData.success) throw new Error(serverData.error || 'Processing failed');
      
      console.log('✅ Server processed:', serverData);
      
      const gw = ARWEAVE_GATEWAY;
      const imageUrl = serverData.image.id ? `${gw}${serverData.image.id}` : `local://${serverData.image.hash}`;
      
      const currentChainConfig = VIZ_CHAINS[this.currentVizChain];
      const isAmoy = this.currentVizChain === 'polygonAmoy' || currentChainConfig?.chainIdHex?.toLowerCase() === '0x13882';
      const nativeTokenSymbol = isAmoy ? 'POL' : (currentChainConfig?.nativeCurrency || 'ETH');
      
      const metadata = {
        name: "Wallet Visualization NFT",
        description: `Generated from wallet ${this.account} on ${new Date().toISOString()}. Stored permanently on Arweave.`,
        image: imageUrl,
        attributes: [
          { trait_type: "Balance Amount", value: this.ethBalance.toString() },
          { trait_type: "Native Token", value: nativeTokenSymbol },
          { trait_type: "Token Count", value: this.tokens.length.toString() },
          { trait_type: "Transaction Count", value: this.txCount.toString() },
          { trait_type: "Visual Style", value: ADDON_STYLES[this.currentAddonStyle]?.name || this.currentAddonStyle },
          { trait_type: "Source Chain", value: this.currentVizChain },
          { trait_type: "Storage", value: "Arweave (Permanent)" },
          { trait_type: "Generated At", value: new Date().toISOString() }
        ]
      };
      
      if (serverData.video?.id) metadata.animation_url = `${gw}${serverData.video.id}`;
      
      const metadataBlob = new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' });
      const metadataFileName = `metadata_${Date.now()}.json`;
      
      showToast('💾 Saving all files as ZIP...', 'info');
      
      const allFiles = [
        { blob: imageBlob, filename: imageFileName },
        { blob: metadataBlob, filename: metadataFileName }
      ];
      if (videoBlob && videoFileName) {
        allFiles.push({ blob: videoBlob, filename: videoFileName });
      }
      await downloadAllFiles(allFiles);
      
      showToast('✅ All files saved as ZIP!', 'success');
      
      let metadataId = null;
      try {
        const metaRes = await uploadMetadataToArweave(metadata);
        metadataId = metaRes.id || metaRes.cid;
        showToast('✅ Metadata uploaded to Arweave!', 'success');
      } catch (e) {
        console.warn('Metadata upload failed:', e);
        showToast('⚠️ Metadata upload failed, continuing anyway', 'warning');
      }
      
      showToast('📝 Preparing mint...', 'info');
      
      let mintData;
      try {
        const mintRes = await apiFetch('/api/mint-with-signature', {
          method: 'POST',
          body: JSON.stringify({
            wallet: this.account,
            metadataUri: metadataId 
              ? `${ARWEAVE_GATEWAY}${metadataId}`
              : serverData.image.id 
                ? `${ARWEAVE_GATEWAY}${serverData.image.id}`
                : `local://${serverData.image.hash}`,
            imageHash: serverData.image.hash,
            videoHash: serverData.video?.hash || null
          })
        });
        mintData = await mintRes.json();
      } catch (apiError) {
        console.error("Mint API error:", apiError);
        throw new Error(`Mint preparation failed: ${apiError.message}`);
      }
      
      if (!mintData.success) throw new Error(mintData.error || 'Mint preparation failed');
      
      showToast('✍️ Preparing transaction...', 'info');
      
      const txValue = BigInt(mintData.transaction.value);
      const txGasLimit = BigInt(mintData.transaction.gasLimit);
      
      console.log('📤 Formatted mint configuration:', {
        to: mintData.transaction.to,
        valueWei: txValue.toString(),
        valueEth: ethers.formatEther(txValue),
        gasLimit: txGasLimit.toString()
      });

      showToast('✍️ Please sign the transaction in your wallet...', 'info');
      const tx = await this.signer.sendTransaction({
        to: mintData.transaction.to,
        data: mintData.transaction.data,
        value: txValue,
        gasLimit: txGasLimit
      });
      
      showToast('⏳ Waiting for confirmation...', 'info');
      await tx.wait();
      showToast('✅ NFT minted!', 'success');
      
      // ✅ RESTARTĒ VIZUALIZĀCIJU UN AKTIVIZĒ POGAS
      resumeVisualization(this);
      
      const arweaveStatus = serverData.arweave.success ? '✅' : '⚠️';
      alert(`✅ NFT minted!\n\n` +
        `Tx: ${tx.hash}\n` +
        `Price: ${ethers.formatEther(txValue)} ETH\n\n` +
        `🔐 Image Hash: ${serverData.image.hash}\n` +
        `${serverData.video ? '🔐 Video Hash: ' + serverData.video.hash + '\n' : ''}` +
        `${metadataId ? '📄 Arweave ID: ' + metadataId + '\n' : ''}` +
        `${serverData.image.id ? '🖼️ Image ID: ' + serverData.image.id + '\n' : ''}` +
        `${serverData.video?.id ? '🎬 Video ID: ' + serverData.video.id + '\n' : ''}` +
        `\n${arweaveStatus} Arweave: ${serverData.arweave.success ? 'OK' : 'Failed (files saved locally)'}` +
        `\n\n💾 All files saved as nft_assets_*.zip`);
      
    } catch (error) {
      console.error(error);
      let msg = error.message || 'Unknown error';
      if (msg.includes('insufficient funds')) msg = '💰 Insufficient funds (Base Sepolia ETH required)';
      if (msg.includes('User denied')) msg = '🛑 Cancelled by user';
      showToast('❌ ' + msg, 'error');
      alert('NFT minting failed.\n\n' + msg);
    } finally { 
      setButtonLoading(UI.generateNFTBtn, false);
      // ✅ Pat ja kļūda, restartē vizualizāciju
      resumeVisualization(this);
    }
  },

  async renderSnapshot(chain) {
    if (MAINTENANCE_CONFIG.isMaintenance) return;
    await renderSnapshot(this, chain);
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
      UI.generateNFTBtn.setAttribute('data-price', '');
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
    console.log("🚀 Starting Wallet Visualizer with Arweave/Turbo Permanent Storage...");
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
        this.setAddonStyle(btn.getAttribute('data-theme'));
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
      aboutBtn.addEventListener("click", () => {
        modal.style.display = "block";
      });

      closeBtn.addEventListener("click", () => {
        modal.style.display = "none";
      });

      window.addEventListener("click", (event) => {
        if (event.target === modal) {
          modal.style.display = "none";
        }
      });
    } else {
      console.warn("⚠️ About modal elements were not found in the DOM.");
    }
    
    window.addEventListener('resize', () => resizeCanvas(this));
    
    if (window.ethereum) {
      window.ethereum.on('chainChanged', () => {
        this.resetApp();
      });
    }
    
    window.LOW_POWER_MODE = LOW_POWER_MODE;
    
    showToast('✨ Welcome! Connect your wallet to begin.', 'info');
    console.log('✅ Wallet Visualizer Ready with Arweave/Turbo Permanent Storage!');
  }
});

window.App = App;
App.init();
