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
import { generateNFT } from './modules/nft-generator.js';

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
    await generateNFT(this);
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
