// ============================================ //
// ARWEAVE/TURBO STORAGE FUNCTIONS
// ============================================ //

import { showToast, showProgress, setProgress, hideProgress } from './ui.js';
import { ARWEAVE_GATEWAY } from './config.js';
import { UI } from './state.js';

/**
 * Parāda augšupielādēto failu priekšskatījumu ar Arweave linkiem
 */
export function showArweavePreview(imageId, videoId, metadataId) {
  if (UI.previewImage) {
    UI.previewImage.innerHTML = '';
    UI.previewVideo.innerHTML = '';
    UI.previewMetadata.innerHTML = '';
    if (imageId) UI.previewImage.innerHTML = `🖼️ Image: <a href="${ARWEAVE_GATEWAY}${imageId}" target="_blank">${imageId.substring(0, 20)}...</a>`;
    if (videoId) UI.previewVideo.innerHTML = `🎬 Video: <a href="${ARWEAVE_GATEWAY}${videoId}" target="_blank">${videoId.substring(0, 20)}...</a>`;
    if (metadataId) UI.previewMetadata.innerHTML = `📄 Metadata: <a href="${ARWEAVE_GATEWAY}${metadataId}" target="_blank">${metadataId.substring(0, 20)}...</a>`;
    if (UI.ipfsPreview) UI.ipfsPreview.style.display = 'block';
    setTimeout(() => { if (UI.ipfsPreview) UI.ipfsPreview.style.display = 'none'; }, 10000);
  }
}

/**
 * Lejupielādē vienu failu lokāli
 */
export function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  console.log(`💾 Lejupielādēts: ${filename}`);
}

/**
 * Lejupielādē visus failus kā ZIP arhīvu
 */
export async function downloadAllFiles(files) {
  // JSZip ir globāli pieejams no CDN (ielādēts index.html)
  const zip = new JSZip();
  
  for (const { blob, filename } of files) {
    zip.file(filename, blob);
  }
  
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nft_assets_${Date.now()}.zip`;
  document.body.appendChild(a);
  a.click();
  
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
  
  console.log(`💾 ZIP arhīvs saglabāts ar ${files.length} failiem`);
}

/**
 * Aprēķina SHA-256 hash no Blob datiem (klienta pusē)
 */
export async function calculateHashFromBlob(blob) {
  const buffer = await blob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = '0x' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

/**
 * Augšupielādē failu caur serveri uz Arweave/Turbo
 */
export async function uploadFileToArweave(file) {
  showToast('Uploading file to Arweave (Turbo)...', 'info');
  
  const formData = new FormData();
  formData.append('file', file);
  
  const token = localStorage.getItem("auth_token");
  const headers = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  
  const res = await fetch('/api/uploadFileToArweave', {
    method: 'POST',
    headers,
    body: formData
  });
  
  if (!res.ok) {
    const errorText = await res.text().catch(() => 'Unknown error');
    throw new Error(`File upload failed: ${res.status} ${errorText}`);
  }
  
  const result = await res.json();
  if (!result.id) throw new Error("Upload failed - no transaction ID returned");
  
  console.log("File uploaded to Arweave:", result.id, "Hash:", result.hash);
  return result;
}

/**
 * Augšupielādē metadatus caur serveri uz Arweave/Turbo
 */
export async function uploadMetadataToArweave(metadata) {
  showToast('Preparing metadata for Arweave...', 'info');
  
  const { apiFetch } = await import('./api.js');
  const response = await apiFetch('/api/uploadMetadataToArweave', {
    method: 'POST',
    body: JSON.stringify(metadata)
  });
  
  if (!response.ok) throw new Error(`Metadata upload failed: ${response.status}`);
  
  showToast('Metadata uploaded to Arweave!', 'success');
  return await response.json();
}

/**
 * Augšupielādē attēlu no canvas uz Arweave
 */
export async function uploadImageToArweave(canvas) {
  showToast('Preparing image for Arweave...', 'info');
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) { reject(new Error('Failed to create image')); return; }
      const file = new File([blob], `snapshot_${Date.now()}.png`, { type: 'image/png' });
      try { 
        showToast('Uploading image to Arweave...', 'info'); 
        resolve(await uploadFileToArweave(file)); 
      } catch (error) { reject(error); }
    }, 'image/png');
  });
}

/**
 * Ieraksta video un augšupielādē uz Arweave
 */
export async function uploadVideoToArweave(stream, duration = 15000) {
  showToast('Recording video for Arweave...', 'info');
  let mimeType = 'video/webm';
  if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/mp4';
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  return new Promise((resolve, reject) => {
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      const ext = mimeType === 'video/mp4' ? 'mp4' : 'webm';
      const blob = new Blob(chunks, { type: mimeType });
      const file = new File([blob], `video_${Date.now()}.${ext}`, { type: mimeType });
      try { 
        showToast('Uploading video to Arweave...', 'info'); 
        resolve(await uploadFileToArweave(file)); 
      } catch (error) { reject(error); }
    };
    recorder.onerror = (event) => {
      const error = event?.error instanceof Error ? event.error : new Error('Recording failed');
      reject(error);
    };
    recorder.start(1000);
    setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, duration);
  });
}
