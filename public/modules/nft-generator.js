import { showToast, showWarning, setButtonLoading } from './ui.js';
import { login, getNFTPrice, getContractAddress } from './api.js';
import { apiFetch } from './api.js';
import { switchToMintChain, switchToVizChain } from './web3.js';
import { VIZ_CHAINS } from './chains.js';
import { CONTRACT_ABI, getMintProvider } from './config.js';
import { calculateHashFromBlob, uploadMetadataToArweave, downloadAllFiles } from './storage.js';
import { ADDON_STYLES } from '../themes.js';

async function createImageFromCanvas(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to create image'));
    }, 'image/png');
  });
}

async function recordVideoFromCanvas(canvas) {
  const stream = canvas.captureStream(30);
  
  return new Promise((resolve, reject) => {
    let mimeType = 'video/webm';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/mp4';
    
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    
    recorder.ondataavailable = (e) => { 
      if (e.data?.size) chunks.push(e.data); 
    };
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.onerror = (event) => reject(event?.error || new Error('Recording failed'));
    
    recorder.start(1000);
    setTimeout(() => { 
      if (recorder.state === 'recording') recorder.stop(); 
    }, 15000);
  });
}

function createMediaFiles(imageBlob, videoBlob) {
  const imageFileName = `snapshot_${Date.now()}.png`;
  const imageFile = new File([imageBlob], imageFileName, { type: 'image/png' });
  
  let videoFile = null, videoFileName = null;
  if (videoBlob) {
    const videoExt = videoBlob.type === 'video/mp4' ? 'mp4' : 'webm';
    videoFileName = `video_${Date.now()}.${videoExt}`;
    videoFile = new File([videoBlob], videoFileName, { type: videoBlob.type });
  }
  
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
    return true;
  } catch (signError) {
    if (signError.message?.includes('User denied') || signError.code === 'ACTION_REJECTED') {
      showToast('🛑 Cancelled by user', 'warning');
    } else {
      showToast('❌ Verification failed', 'error');
    }
    return false;
  }
}

async function switchToBaseAndReauth(app) {
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
  return true;
}

async function fetchMintPrice(contractAddress, uiElement) {
  if (!contractAddress) return;
  
  try {
    const stableProvider = await getMintProvider();
    const contract = new ethers.Contract(contractAddress, CONTRACT_ABI, stableProvider);
    const priceWei = await contract.mintPrice();
    const mintPriceEth = ethers.formatEther(priceWei);
    uiElement.dataset.price = mintPriceEth;
  } catch (e) {
    console.warn("Could not fetch price on mint chain:", e);
  }
}

async function requestMintTransaction(account, imageHash, videoHash, tempContentHash) {
  showToast('📝 Requesting mint reservation...', 'info');
  
  const requestRes = await apiFetch('/api/request-mint', {
    method: 'POST',
    body: JSON.stringify({
      wallet: account,
      imageHash,
      videoHash,
      contentHash: tempContentHash
    })
  });
  
  const requestData = await requestRes.json();
  if (!requestData.success) throw new Error(requestData.error || 'Mint request failed');
  
  return requestData;
}

async function sendMintTransaction(signer, requestData) {
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
  
  return tx;
}

async function uploadToArweave(imageFile, videoFile) {
  showToast('📤 Uploading to Arweave...', 'info');
  
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
    throw new Error('Arweave upload failed. Your deposit will be refunded automatically.');
  }
  
  const serverData = await serverRes.json();
  if (!serverData.success) throw new Error(serverData.error || 'Arweave processing failed');
  
  return serverData;
}

function createNFTMetadata(app, imageFileName, videoFileName, tokenList, nftList, snapshotData) {
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

async function finalizeMintOnChain(account, metadataUri, storageCostWei, finalContentHash) {
  showToast('🔒 Finalizing your NFT on blockchain...', 'info');
  
  const finalizeRes = await apiFetch('/api/finalize-mint', {
    method: 'POST',
    body: JSON.stringify({
      wallet: account,
      metadataUri,
      storageCostWei,
      contentHash: finalContentHash
    })
  });
  
  const finalizeData = await finalizeRes.json();
  if (!finalizeData.success) throw new Error(finalizeData.error || 'Finalize failed');
  
  showToast('✅ NFT finalized on blockchain!', 'success');
}

async function saveFilesLocally(imageBlob, videoBlob, metadata) {
  showToast('💾 Saving all files as ZIP...', 'info');
  
  const metadataString = JSON.stringify(metadata, null, 2);
  const metadataBlob = new Blob([metadataString], { type: 'application/json' });
  const metadataFileName = `metadata_${Date.now()}.json`;
  
  const files = [
    { blob: imageBlob, filename: metadata.image },
    { blob: metadataBlob, filename: metadataFileName }
  ];
  
  if (videoBlob && metadata.animation_url) {
    files.push({ blob: videoBlob, filename: metadata.animation_url });
  }
  
  await downloadAllFiles(files);
  showToast('✅ All files saved as ZIP!', 'success');
}

export async function generateNFT(app) {
  if (!app.account || !app.provider || !app.signer) {
    showToast('🔌 Please connect your wallet first', 'warning');
    return;
  }
  
  setButtonLoading(UI.generateNFTBtn, true);
  showWarning('⚠️ Do not close this tab until minting is complete!', true);
  
  const previousShowInfo = app.showInfo;
  app.showInfo = false;
  
  try {
    // 1. Anti-bot verification
    const verified = await signAntiBotMessage(app.signer, app.account);
    if (!verified) {
      app.showInfo = previousShowInfo;
      setButtonLoading(UI.generateNFTBtn, false);
      showWarning('', false);
      return;
    }
    
    // 2. Create image and video
    showToast('📸 Creating your NFT files...', 'info');
    
    const imageBlob = await createImageFromCanvas(UI.canvas);
    const videoBlob = await recordVideoFromCanvas(UI.canvas);
    
    if (!videoBlob) {
      throw new Error('Failed to record video. Cannot mint NFT.');
    }
    
    showToast('🎬 Video recorded!', 'success');
    app.showInfo = previousShowInfo;
    
    // 3. Prepare data
    const { imageFile, videoFile } = createMediaFiles(imageBlob, videoBlob);
    const imageHash = await calculateHashFromBlob(imageBlob);
    const videoHash = await calculateHashFromBlob(videoBlob);
    const tempContentHash = createTempContentHash(app.account, imageHash, videoHash);
    
    // 4. Switch to Base and request mint
    const switched = await switchToBaseAndReauth(app);
    if (!switched) throw new Error('Failed to switch to Base network');
    
    const contractAddress = await getContractAddress();
    await fetchMintPrice(contractAddress, UI.generateNFTBtn);
    
    const requestData = await requestMintTransaction(app.account, imageHash, videoHash, tempContentHash);
    const tx = await sendMintTransaction(app.signer, requestData);
    
    // 5. Upload to Arweave
    const serverData = await uploadToArweave(imageFile, videoFile);
    console.log('✅ Server processed:', serverData);
    
    // 6. Create and upload metadata
    const tokenList = app.tokens.filter(t => !t.isNFT).map(t => ({ symbol: t.symbol, address: t.address, balance: t.balance }));
    const nftList = app.tokens.filter(t => t.isNFT).map(n => ({ symbol: n.symbol, address: n.address, tokenId: n.tokenId }));
    
    const snapshotData = {
      ethBalance: app.ethBalance?.toString() || "0",
      txCount: app.txCount?.toString() || "0",
      tokenCount: tokenList.length.toString(),
      nftCount: nftList.length.toString()
    };
    
    const imageFileName = imageFile.name;
    const videoFileName = videoFile.name;
    const metadata = createNFTMetadata(app, imageFileName, videoFileName, tokenList, nftList, snapshotData);
    
    const metadataString = JSON.stringify(metadata, null, 2);
    const finalContentHash = await calculateHashFromBlob(new Blob([metadataString]));
    
    const metaRes = await uploadMetadataToArweave(metadata);
    const metaId = metaRes.id || metaRes.cid;
    showToast('✅ Metadata uploaded to Arweave!', 'success');
    
    // 7. Finalize on chain
    const metadataUri = `https://arweave.net/${metaId}`;
    await finalizeMintOnChain(app.account, metadataUri, serverData.storage?.costWei || "0", finalContentHash);
    
    // 8. Save files locally
    await saveFilesLocally(imageBlob, videoBlob, metadata);
    
    showWarning('', false);
    
    // 9. Show success
    const txValue = ethers.formatEther(BigInt(requestData.transaction.value));
    const storageCostEth = serverData.storage?.costEth || "0";
    
    alert(`✅ NFT minted!\n\n` +
      `Tx: ${tx.hash}\n` +
      `Price: ${txValue} ETH\n` +
      `(Storage: ${storageCostEth} ETH)\n\n` +
      `🔐 Image Hash: ${imageHash}\n` +
      `🔐 Video Hash: ${videoHash}\n` +
      `🔐 Content Hash: ${finalContentHash}\n` +
      `${metaId ? '📄 Arweave Metadata: ' + metaId + '\n' : ''}\n\n` +
      `💾 All files saved as nft_assets_*.zip`);
    
    // 10. Refresh visualization
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
  } finally {
    app.showInfo = previousShowInfo;
    setButtonLoading(UI.generateNFTBtn, false);
  }
}
