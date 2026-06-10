import { requireAuth } from "../_lib/auth.js";
import { checkRateLimit } from "../_lib/rateLimit.js";
import lighthouse from '@lighthouse-web3/sdk';
import crypto from 'crypto';

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'video/mp4', 'video/webm'];
const MAX_SIZE = 50 * 1024 * 1024;

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const user = await requireAuth(request, env);
    if (user instanceof Response) return user;
    if (!user || !user.address) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" }
      });
    }

    const rateKey = `prepare-nft:${user.address.toLowerCase()}`;
    if (!(await checkRateLimit({ key: rateKey, limit: 5, windowMs: 60000 }, env))) {
      return new Response(JSON.stringify({ error: 'Too many requests. Try again later.' }), {
        status: 429, headers: { "Content-Type": "application/json" }
      });
    }

    let formData;
    try {
      formData = await request.formData();
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid form data" }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    const imageFile = formData.get('image');
    const videoFile = formData.get('video');

    if (!imageFile || !(imageFile instanceof File)) {
      return new Response(JSON.stringify({ error: 'No image file provided' }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    const imageType = imageFile.type || 'image/png';
    const imageName = imageFile.name || 'snapshot.png';
    const imageSize = imageFile.size;

    if (!ALLOWED_TYPES.includes(imageType)) {
      return new Response(JSON.stringify({ error: `Image type not allowed: ${imageType}` }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }
    if (imageSize > MAX_SIZE) {
      return new Response(JSON.stringify({ error: 'Image too large. Max 50MB' }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    let videoBuffer = null;
    let videoType = null;
    let videoName = null;
    let videoSize = null;

    if (videoFile && videoFile instanceof File) {
      videoType = videoFile.type || 'video/webm';
      videoName = videoFile.name || 'video.webm';
      videoSize = videoFile.size;

      if (!ALLOWED_TYPES.includes(videoType)) {
        return new Response(JSON.stringify({ error: `Video type not allowed: ${videoType}` }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }
      if (videoSize > MAX_SIZE) {
        return new Response(JSON.stringify({ error: 'Video too large. Max 50MB' }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }

      const videoArrayBuffer = await videoFile.arrayBuffer();
      videoBuffer = Buffer.from(videoArrayBuffer);
    }

    console.log(`🚀 Apstrādājam NFT failus lietotājam ${user.address}...`);

    const imageArrayBuffer = await imageFile.arrayBuffer();
    const imageBuffer = Buffer.from(imageArrayBuffer);
    const imageHash = '0x' + crypto.createHash('sha256').update(imageBuffer).digest('hex');
    console.log('🔐 Image Hash:', imageHash);

    let videoHash = null;
    if (videoBuffer) {
      videoHash = '0x' + crypto.createHash('sha256').update(videoBuffer).digest('hex');
      console.log('🔐 Video Hash:', videoHash);
    }

    let imageCid = null;
    let videoCid = null;
    let lighthouseError = null;

    if (env.LIGHTHOUSE_API_KEY) {
      try {
        console.log('📤 Mēģinam augšupielādēt attēlu caur Lighthouse SDK...');
        
        const uploadResponse = await lighthouse.uploadBuffer(
          imageBuffer,
          env.LIGHTHOUSE_API_KEY,
          false,
          null,
          { storageType: "annual" }
        );

        imageCid = uploadResponse?.data?.Hash || uploadResponse?.Hash;
        if (imageCid) {
          console.log('✅ Attēls augšupielādēts Lighthouse:', imageCid);
        } else {
          console.warn('⚠️ Lighthouse SDK neatgrieza CID attēlam');
          lighthouseError = 'No CID returned';
        }
      } catch (error) {
        console.warn('⚠️ Lighthouse attēla augšupielādes kļūda:', error.message);
        lighthouseError = error.message;
      }

      if (videoBuffer) {
        try {
          console.log('📤 Mēģinam augšupielādēt video caur Lighthouse SDK...');
          
          const uploadResponse = await lighthouse.uploadBuffer(
            videoBuffer,
            env.LIGHTHOUSE_API_KEY,
            false,
            null,
            { storageType: "annual" }
          );

          videoCid = uploadResponse?.data?.Hash || uploadResponse?.Hash;
          if (videoCid) {
            console.log('✅ Video augšupielādēts Lighthouse:', videoCid);
          } else {
            console.warn('⚠️ Lighthouse SDK neatgrieza CID video');
          }
        } catch (error) {
          console.warn('⚠️ Lighthouse video augšupielādes kļūda:', error.message);
        }
      }
    } else {
      lighthouseError = 'No API key configured';
      console.warn('⚠️ LIGHTHOUSE_API_KEY nav konfigurēts');
    }

    const responseData = {
      success: true,
      image: {
        hash: imageHash,
        cid: imageCid || null,
        fileName: imageName,
        mimeType: imageType,
        size: imageSize
      },
      video: videoBuffer ? {
        hash: videoHash,
        cid: videoCid || null,
        fileName: videoName,
        mimeType: videoType,
        size: videoSize
      } : null,
      lighthouse: {
        success: !!(imageCid || videoCid),
        error: lighthouseError
      }
    };

    console.log(`✅ NFT sagatavošana pabeigta! Image hash: ${imageHash}`);

    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error('💥 prepare-nft kļūda:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
