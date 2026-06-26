// functions/api/prepare-nft.js
// Pēc veiksmīgas Arweave augšupielādes AUTOMĀTISKI izsauc finalizeMint
import { requireAuth } from "../_lib/auth.js";
import { checkRateLimit } from "../_lib/rateLimit.js";
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';
import { ethers } from 'ethers';
import crypto from 'crypto';
import axios from 'axios';

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'video/mp4', 'video/webm'];
const MAX_SIZE = 50 * 1024 * 1024;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function validateFile(file, fieldName, isRequired = true) {
  if (isRequired && (!file || !(file instanceof File))) {
    return { error: `No ${fieldName} file provided` };
  }
  
  if (!file) return { file: null };
  
  const fileType = file.type || (fieldName === 'image' ? 'image/png' : 'video/webm');
  const fileName = file.name || (fieldName === 'image' ? 'snapshot.png' : 'video.webm');
  const fileSize = file.size;

  if (!ALLOWED_TYPES.includes(fileType)) {
    return { error: `${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)} type not allowed: ${fileType}` };
  }
  if (fileSize > MAX_SIZE) {
    return { error: `${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)} too large. Max 50MB` };
  }

  return { file: { fileRef: file, type: fileType, name: fileName, size: fileSize } };
}

async function fileToBufferWithHash(file) {
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const hash = '0x' + crypto.createHash('sha256').update(buffer).digest('hex');
  return { buffer, hash };
}

function createTurboUploader(arweaveKey) {
  const signer = new EthereumSigner(arweaveKey);
  return TurboFactory.authenticated({
    signer,
    token: 'base-eth',
    gatewayUrl: 'https://sepolia.base.org',
    paymentServiceConfig: { url: 'https://payment.ardrive.dev' },
    uploadServiceConfig: { url: 'https://upload.ardrive.dev' }
  });
}

async function uploadFileToArweave(turbo, buffer, metadata, type) {
  try {
    console.log(`📤 Uploading ${type} to Arweave via Turbo...`);
    const result = await turbo.upload({
      data: buffer,
      dataItemOpts: {
        tags: [
          { name: "Content-Type", value: metadata.mimeType },
          { name: "App-Name", value: "WalletVisualizer-v2.0" },
          { name: "User-Address", value: metadata.userAddress },
          { name: "File-Hash", value: metadata.hash },
          { name: "NFT-Asset-Type", value: type }
        ]
      }
    });
    
    if (result?.id) {
      console.log(`✅ ${type} uploaded to Arweave:`, result.id);
      return { id: result.id, bytesUploaded: metadata.size };
    }
    
    console.warn(`⚠️ Turbo SDK did not return TX ID for ${type}`);
    return { error: `No TX ID returned for ${type}` };
  } catch (error) {
    console.warn(`⚠️ Arweave ${type} upload error:`, error.message);
    return { error: error.message };
  }
}

async function uploadToArweave(arweaveKey, imageData, videoData) {
  let imageId = null, videoId = null, arweaveError = null;
  let totalBytesUploaded = 0;
  let storageCostWei = "0", storageCostEth = "0";

  if (!arweaveKey) {
    console.warn('⚠️ ARWEAVE_STORAGE_KEY not configured');
    return { imageId, videoId, arweaveError: 'No ARWEAVE_STORAGE_KEY configured', totalBytesUploaded, storageCostWei, storageCostEth };
  }

  try {
    const turbo = createTurboUploader(arweaveKey);

    // Augšupielādē attēlu
    const imageResult = await uploadFileToArweave(turbo, imageData.buffer, {
      mimeType: imageData.type,
      userAddress: imageData.userAddress,
      hash: imageData.hash,
      size: imageData.size
    }, 'image');
    
    if (imageResult.id) {
      imageId = imageResult.id;
      totalBytesUploaded += imageData.size;
    } else if (imageResult.error) {
      arweaveError = imageResult.error;
    }

    // Augšupielādē video, ja pieejams
    if (videoData) {
      const videoResult = await uploadFileToArweave(turbo, videoData.buffer, {
        mimeType: videoData.type,
        userAddress: videoData.userAddress,
        hash: videoData.hash,
        size: videoData.size
      }, 'video');
      
      if (videoResult.id) {
        videoId = videoResult.id;
        totalBytesUploaded += videoData.size;
      }
    }

    // Aprēķina uzglabāšanas izmaksas
    if (totalBytesUploaded > 0) {
      try {
        const { tokenPrice } = await turbo.getTokenPriceForBytes({ byteCount: totalBytesUploaded });
        storageCostEth = tokenPrice.toString();
        storageCostWei = ethers.parseEther(storageCostEth).toString();
        console.log(`💰 Storage cost: ${storageCostEth} ETH for ${totalBytesUploaded} bytes`);
      } catch (priceError) {
        console.warn('⚠️ Could not calculate storage price:', priceError.message);
      }
    }
  } catch (initError) {
    console.warn('⚠️ Turbo initialization error:', initError.message);
    arweaveError = initError.message;
  }

  return { imageId, videoId, arweaveError, totalBytesUploaded, storageCostWei, storageCostEth };
}

async function autoFinalizeMint(imageId, storageCostWei, userAddress, request) {
  if (!imageId) return;

  try {
    console.log('🚀 Auto-finalizing mint after successful Arweave upload...');
    
    await axios.post(`${request.url.replace('/prepare-nft', '/finalize-mint')}`, {
      wallet: userAddress,
      metadataUri: `https://arweave.net/${imageId}`,
      storageCostWei,
      contentHash: ethers.ZeroHash
    }, {
      headers: { Authorization: request.headers.get('Authorization') || '' }
    });
    
    console.log('✅ Auto-finalize request sent!');
  } catch (finalizeError) {
    console.warn('⚠️ Auto-finalize failed, will be picked up by cleanup robot:', finalizeError.message);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // Auth validācija
    const user = await requireAuth(request, env);
    if (user instanceof Response) return user;
    if (!user?.address) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    // Rate limiting
    const rateKey = `prepare-nft:${user.address.toLowerCase()}`;
    if (!(await checkRateLimit({ key: rateKey, limit: 5, windowMs: 60000 }, env))) {
      return jsonResponse({ error: 'Too many requests. Try again later.' }, 429);
    }

    // Form data apstrāde
    let formData;
    try {
      formData = await request.formData();
    } catch (e) {
      return jsonResponse({ error: "Invalid form data" }, 400);
    }

    // Failu validācija
    const { file: imageFile, error: imageError } = validateFile(formData.get('image'), 'image');
    if (imageError) return jsonResponse({ error: imageError }, 400);

    const { file: videoFile, error: videoError } = validateFile(formData.get('video'), 'video', false);
    if (videoError) return jsonResponse({ error: videoError }, 400);

    console.log(`🚀 Processing NFT files for user ${user.address}...`);

    // Hash aprēķins
    const { buffer: imageBuffer, hash: imageHash } = await fileToBufferWithHash(imageFile.fileRef);
    console.log('🔐 Image Hash:', imageHash);

    let videoHash = null, videoBuffer = null;
    if (videoFile) {
      const result = await fileToBufferWithHash(videoFile.fileRef);
      videoBuffer = result.buffer;
      videoHash = result.hash;
      console.log('🔐 Video Hash:', videoHash);
    }

    // Arweave augšupielāde
    const { imageId, videoId, arweaveError, totalBytesUploaded, storageCostWei, storageCostEth } = 
      await uploadToArweave(
        env.ARWEAVE_STORAGE_KEY,
        { buffer: imageBuffer, type: imageFile.type, userAddress: user.address.toLowerCase(), hash: imageHash, size: imageFile.size },
        videoFile ? { buffer: videoBuffer, type: videoFile.type, userAddress: user.address.toLowerCase(), hash: videoHash, size: videoFile.size } : null
      );

    // Auto-finalize
    const arweaveSuccess = !!(imageId || videoId);
    if (arweaveSuccess) {
      await autoFinalizeMint(imageId, storageCostWei, user.address, request);
    }

    // Atbildes sagatavošana
    const responseData = {
      success: true,
      image: { hash: imageHash, id: imageId || null, fileName: imageFile.name, mimeType: imageFile.type, size: imageFile.size },
      video: videoFile ? { hash: videoHash, id: videoId || null, fileName: videoFile.name, mimeType: videoFile.type, size: videoFile.size } : null,
      arweave: { success: arweaveSuccess, error: arweaveError },
      storage: { bytesUploaded: totalBytesUploaded, costWei: storageCostWei, costEth: storageCostEth }
    };

    console.log(`✅ NFT preparation complete! Image hash: ${imageHash}`);
    return jsonResponse(responseData);

  } catch (error) {
    console.error('💥 prepare-nft error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}
