// functions/api/prepare-nft.js
// Pēc veiksmīgas Arweave augšupielādes AUTOMĀTISKI izsauc finalizeMint
import { requireAuth } from "../_lib/auth.js";
import { checkRateLimit } from "../_lib/rateLimit.js";
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';
import { ethers } from 'ethers';
import crypto from 'crypto';

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'video/mp4', 'video/webm'];
const MAX_SIZE = 50 * 1024 * 1024;

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const user = await requireAuth(request, env);
    if (user instanceof Response) return user;
    if (!user || !user.address) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }

    const rateKey = `prepare-nft:${user.address.toLowerCase()}`;
    if (!(await checkRateLimit({ key: rateKey, limit: 5, windowMs: 60000 }, env))) {
      return new Response(JSON.stringify({ error: 'Too many requests. Try again later.' }), { status: 429, headers: { "Content-Type": "application/json" } });
    }

    let formData;
    try { formData = await request.formData(); } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid form data" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    const imageFile = formData.get('image');
    const videoFile = formData.get('video');

    if (!imageFile || !(imageFile instanceof File)) {
      return new Response(JSON.stringify({ error: 'No image file provided' }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    const imageType = imageFile.type || 'image/png';
    const imageName = imageFile.name || 'snapshot.png';
    const imageSize = imageFile.size;

    if (!ALLOWED_TYPES.includes(imageType)) {
      return new Response(JSON.stringify({ error: `Image type not allowed: ${imageType}` }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    if (imageSize > MAX_SIZE) {
      return new Response(JSON.stringify({ error: 'Image too large. Max 50MB' }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    let videoBuffer = null, videoType = null, videoName = null, videoSize = null;

    if (videoFile && videoFile instanceof File) {
      videoType = videoFile.type || 'video/webm';
      videoName = videoFile.name || 'video.webm';
      videoSize = videoFile.size;

      if (!ALLOWED_TYPES.includes(videoType)) {
        return new Response(JSON.stringify({ error: `Video type not allowed: ${videoType}` }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      if (videoSize > MAX_SIZE) {
        return new Response(JSON.stringify({ error: 'Video too large. Max 50MB' }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      const videoArrayBuffer = await videoFile.arrayBuffer();
      videoBuffer = Buffer.from(videoArrayBuffer);
    }

    console.log(`🚀 Processing NFT files for user ${user.address}...`);

    const imageArrayBuffer = await imageFile.arrayBuffer();
    const imageBuffer = Buffer.from(imageArrayBuffer);
    const imageHash = '0x' + crypto.createHash('sha256').update(imageBuffer).digest('hex');
    console.log('🔐 Image Hash:', imageHash);

    let videoHash = null;
    if (videoBuffer) {
      videoHash = '0x' + crypto.createHash('sha256').update(videoBuffer).digest('hex');
      console.log('🔐 Video Hash:', videoHash);
    }

    let imageId = null, videoId = null, arweaveError = null;
    let totalBytesUploaded = 0;
    let storageCostWei = "0", storageCostEth = "0";

    if (env.ARWEAVE_STORAGE_KEY) {
      try {
        const signer = new EthereumSigner(env.ARWEAVE_STORAGE_KEY);
        const turbo = TurboFactory.authenticated({
          signer, token: 'base-eth', gatewayUrl: 'https://sepolia.base.org',
          paymentServiceConfig: { url: 'https://payment.ardrive.dev' },
          uploadServiceConfig: { url: 'https://upload.ardrive.dev' }
        });

        try {
          console.log('📤 Uploading image to Arweave via Turbo...');
          const imageResult = await turbo.upload({
            data: imageBuffer,
            dataItemOpts: { tags: [
              { name: "Content-Type", value: imageType }, { name: "App-Name", value: "WalletVisualizer-v2.0" },
              { name: "User-Address", value: user.address.toLowerCase() }, { name: "File-Hash", value: imageHash }, { name: "NFT-Asset-Type", value: "image" }
            ]}
          });
          imageId = imageResult?.id;
          if (imageId) { console.log('✅ Image uploaded to Arweave:', imageId); totalBytesUploaded += imageSize; }
          else { console.warn('⚠️ Turbo SDK did not return TX ID for image'); arweaveError = 'No TX ID returned for image'; }
        } catch (imageError) { console.warn('⚠️ Arweave image upload error:', imageError.message); arweaveError = imageError.message; }

        if (videoBuffer) {
          try {
            console.log('📤 Uploading video to Arweave via Turbo...');
            const videoResult = await turbo.upload({
              data: videoBuffer,
              dataItemOpts: { tags: [
                { name: "Content-Type", value: videoType }, { name: "App-Name", value: "WalletVisualizer-v2.0" },
                { name: "User-Address", value: user.address.toLowerCase() }, { name: "File-Hash", value: videoHash }, { name: "NFT-Asset-Type", value: "video" }
              ]}
            });
            videoId = videoResult?.id;
            if (videoId) { console.log('✅ Video uploaded to Arweave:', videoId); totalBytesUploaded += videoSize; }
            else { console.warn('⚠️ Turbo SDK did not return TX ID for video'); }
          } catch (videoError) { console.warn('⚠️ Arweave video upload error:', videoError.message); }
        }

        if (totalBytesUploaded > 0) {
          try {
            const { tokenPrice } = await turbo.getTokenPriceForBytes({ byteCount: totalBytesUploaded });
            storageCostEth = tokenPrice.toString();
            storageCostWei = ethers.parseEther(storageCostEth).toString();
            console.log(`💰 Storage cost: ${storageCostEth} ETH (${storageCostWei} wei) for ${totalBytesUploaded} bytes`);
          } catch (priceError) { console.warn('⚠️ Could not calculate storage price:', priceError.message); }
        }
      } catch (initError) { console.warn('⚠️ Turbo initialization error:', initError.message); arweaveError = initError.message; }
    } else {
      arweaveError = 'No ARWEAVE_STORAGE_KEY configured';
      console.warn('⚠️ ARWEAVE_STORAGE_KEY not configured - files saved locally only');
    }

    const arweaveSuccess = !!(imageId || videoId);

    // 🚀 JAUNS: Ja Arweave veiksmīgs, AUTOMĀTISKI finalizē mintu
    if (arweaveSuccess && imageId) {
      try {
        console.log('🚀 Auto-finalizing mint after successful Arweave upload...');
        const metadataUri = `https://arweave.net/${imageId}`;
        const contentHash = ethers.ZeroHash;
        
        await axios.post(`${request.url.replace('/prepare-nft', '/finalize-mint')}`, {
          wallet: user.address,
          metadataUri: metadataUri,
          storageCostWei: storageCostWei,
          contentHash: contentHash
        }, {
          headers: { Authorization: request.headers.get('Authorization') || '' }
        });
        console.log('✅ Auto-finalize request sent!');
      } catch (finalizeError) {
        console.warn('⚠️ Auto-finalize failed, will be picked up by cleanup robot:', finalizeError.message);
      }
    }

    const responseData = {
      success: true,
      image: { hash: imageHash, id: imageId || null, fileName: imageName, mimeType: imageType, size: imageSize },
      video: videoBuffer ? { hash: videoHash, id: videoId || null, fileName: videoName, mimeType: videoType, size: videoSize } : null,
      arweave: { success: arweaveSuccess, error: arweaveError },
      storage: { bytesUploaded: totalBytesUploaded, costWei: storageCostWei, costEth: storageCostEth }
    };

    console.log(`✅ NFT preparation complete! Image hash: ${imageHash}`);

    return new Response(JSON.stringify(responseData), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (error) {
    console.error('💥 prepare-nft error:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
