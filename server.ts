import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

// Lazy Google Gen AI Client
let aiClient: GoogleGenAI | null = null;
function getAIClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not configured in server environment.');
    }
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    hasGeminiKey: !!process.env.GEMINI_API_KEY,
    uptimeSeconds: Math.floor(process.uptime()),
    memoryUsageMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
  });
});

// Admin System Stats endpoint
app.get('/api/admin/stats', (req, res) => {
  res.json({
    status: 'operational',
    nodeVersion: process.version,
    uptime: Math.floor(process.uptime()),
    memoryUsage: {
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
    },
    features: {
      photoToLink: true,
      geminiChat: true,
      youtubeDownloader: true,
      spotifyDownloader: true,
      dynamicQr: true,
      ektpMockup: true,
      apiKeyManager: true,
      firestoreSync: true
    },
    totalPhotosHosted: photoStorage.size,
    hasEnvGeminiKey: !!process.env.GEMINI_API_KEY
  });
});

// In-memory Photo Storage for Photo-to-Link
interface HostedPhoto {
  id: string;
  title: string;
  mimeType: string;
  buffer: Buffer;
  sizeBytes: number;
  width?: number;
  height?: number;
  uploadedAt: string;
}
const photoStorage = new Map<string, HostedPhoto>();

// Direct Image Serving Endpoint (Real Image URL)
app.get('/api/i/:id', (req, res) => {
  const photo = photoStorage.get(req.params.id);
  if (!photo) {
    return res.status(404).send('Gambar tidak ditemukan atau sesi telah berakhir');
  }
  res.setHeader('Content-Type', photo.mimeType || 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(photo.title || 'image')}"`);
  return res.send(photo.buffer);
});

// Photo to Link Upload Endpoint
app.post('/api/upload-photo', (req, res) => {
  try {
    const { imageBase64, title, mimeType, width, height } = req.body;
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ error: 'imageBase64 data diperlukan' });
    }

    // Strip data URL prefix if present
    const base64Clean = imageBase64.replace(/^data:image\/[a-zA-Z0-9+-]+;base64,/, '');
    const buffer = Buffer.from(base64Clean, 'base64');
    
    // Auto-detect mime type
    let finalMime = mimeType || 'image/png';
    if (!mimeType) {
      if (imageBase64.startsWith('data:image/jpeg') || imageBase64.startsWith('data:image/jpg')) finalMime = 'image/jpeg';
      else if (imageBase64.startsWith('data:image/webp')) finalMime = 'image/webp';
      else if (imageBase64.startsWith('data:image/gif')) finalMime = 'image/gif';
      else if (imageBase64.startsWith('data:image/svg+xml')) finalMime = 'image/svg+xml';
    }

    const extMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/svg+xml': 'svg'
    };
    const ext = extMap[finalMime] || 'png';

    const photoId = 'img_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36);
    const photoRecord: HostedPhoto = {
      id: photoId,
      title: title || `image_${Date.now()}.${ext}`,
      mimeType: finalMime,
      buffer,
      sizeBytes: buffer.length,
      width: Number(width) || undefined,
      height: Number(height) || undefined,
      uploadedAt: new Date().toISOString()
    };

    photoStorage.set(photoId, photoRecord);

    // If storage gets too large (> 100 images in prototype), clean up oldest
    if (photoStorage.size > 150) {
      const firstKey = photoStorage.keys().next().value;
      if (firstKey) photoStorage.delete(firstKey);
    }

    // Determine host origin
    const host = req.get('host') || 'localhost:3000';
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const origin = `${protocol}://${host}`;
    const directUrl = `${origin}/api/i/${photoId}`;
    const viewUrl = `${origin}/#photo-${photoId}`;

    return res.json({
      success: true,
      id: photoId,
      title: photoRecord.title,
      directUrl,
      viewUrl,
      mimeType: finalMime,
      sizeBytes: photoRecord.sizeBytes,
      sizeFormatted: (photoRecord.sizeBytes / 1024 < 1024) 
        ? `${(photoRecord.sizeBytes / 1024).toFixed(1)} KB` 
        : `${(photoRecord.sizeBytes / (1024 * 1024)).toFixed(2)} MB`,
      width: photoRecord.width,
      height: photoRecord.height,
      uploadedAt: photoRecord.uploadedAt,
      embedCodes: {
        directLink: directUrl,
        markdown: `![${photoRecord.title}](${directUrl})`,
        html: `<img src="${directUrl}" alt="${photoRecord.title}" />`,
        bbcode: `[img]${directUrl}[/img]`,
        shortLink: `${origin}/api/i/${photoId}`
      }
    });
  } catch (err: any) {
    console.error('Error uploading photo to link:', err);
    return res.status(500).json({ error: 'Gagal memproses unggahan foto: ' + err.message });
  }
});

// Admin API Key validation endpoint
app.post('/api/admin/validate-key', async (req, res) => {
  const { type, key } = req.body;
  const startTime = Date.now();

  if (!key || typeof key !== 'string') {
    return res.status(400).json({ valid: false, message: 'Kunci API tidak boleh kosong' });
  }

  try {
    if (type === 'gemini') {
      const testAI = new GoogleGenAI({ apiKey: key.trim() });
      const testRes = await testAI.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }]
      });
      const latency = Date.now() - startTime;
      return res.json({
        valid: true,
        message: 'Koneksi Gemini AI Berhasil! (Response: OK)',
        latencyMs: latency,
        previewText: testRes.text ? testRes.text.slice(0, 30) : 'OK'
      });
    } else if (type === 'rapidapi') {
      // RapidAPI basic validation
      if (key.trim().length >= 30) {
        return res.json({
          valid: true,
          message: 'Format RapidAPI Key Valid',
          latencyMs: Date.now() - startTime
        });
      } else {
        return res.json({
          valid: false,
          message: 'Format RapidAPI Key tampak terlalu pendek (< 30 karakter)',
          latencyMs: Date.now() - startTime
        });
      }
    } else {
      return res.json({
        valid: true,
        message: 'Format Kunci API Tersimpan',
        latencyMs: Date.now() - startTime
      });
    }
  } catch (error: any) {
    return res.status(200).json({
      valid: false,
      message: error.message || 'Verifikasi API Key gagal',
      latencyMs: Date.now() - startTime
    });
  }
});

// Helper to extract YouTube Video ID
function extractYouTubeVideoId(url: string): string | null {
  if (!url) return null;
  const str = url.trim();
  const match = str.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/|live\/))([\w-]{11})/i);
  if (match && match[1]) return match[1];
  if (/^[\w-]{11}$/.test(str)) return str;
  return null;
}

// Real YouTube Video Details & Streams Resolver
app.post('/api/youtube/info', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL YouTube diperlukan' });
    }

    const videoId = extractYouTubeVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: 'URL YouTube tidak valid atau ID video tidak ditemukan' });
    }

    const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
    let title = `YouTube Video (${videoId})`;
    let authorName = 'YouTube Channel';
    let authorUrl = 'https://www.youtube.com';
    let thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    const thumbnailHq = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    const thumbnailMq = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;

    // Fetch official metadata from YouTube oEmbed API
    try {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(cleanUrl)}&format=json`;
      const response = await fetch(oembedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) {
        const data: any = await response.json();
        if (data.title) title = data.title;
        if (data.author_name) authorName = data.author_name;
        if (data.author_url) authorUrl = data.author_url;
        if (data.thumbnail_url) thumbnailUrl = data.thumbnail_url;
      }
    } catch (err: any) {
      console.warn('oEmbed fetch notice:', err.message);
    }

    return res.json({
      success: true,
      videoId,
      title,
      authorName,
      authorUrl,
      cleanUrl,
      thumbnailUrl,
      thumbnailHq,
      thumbnailMq,
      embedUrl: `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`,
      formats: [
        { quality: '1080p Full HD', format: 'MP4', type: 'video', downloadUrl: `https://loader.to/api/button/?url=${encodeURIComponent(cleanUrl)}&f=1080` },
        { quality: '720p HD', format: 'MP4', type: 'video', downloadUrl: `https://loader.to/api/button/?url=${encodeURIComponent(cleanUrl)}&f=720` },
        { quality: '480p SD', format: 'MP4', type: 'video', downloadUrl: `https://loader.to/api/button/?url=${encodeURIComponent(cleanUrl)}&f=480` },
        { quality: '360p Fast', format: 'MP4', type: 'video', downloadUrl: `https://loader.to/api/button/?url=${encodeURIComponent(cleanUrl)}&f=360` },
        { quality: '320 kbps High Quality', format: 'MP3', type: 'audio', downloadUrl: `https://loader.to/api/button/?url=${encodeURIComponent(cleanUrl)}&f=mp3` },
        { quality: '128 kbps Standard', format: 'MP3', type: 'audio', downloadUrl: `https://loader.to/api/button/?url=${encodeURIComponent(cleanUrl)}&f=128` },
        { quality: 'M4A Audio HQ', format: 'M4A', type: 'audio', downloadUrl: `https://loader.to/api/button/?url=${encodeURIComponent(cleanUrl)}&f=m4a` }
      ]
    });
  } catch (error: any) {
    console.error('YouTube Info API Error:', error);
    return res.status(500).json({ error: error.message || 'Gagal memproses detail video YouTube' });
  }
});

// Real Spotify Track Metadata Resolver
app.post('/api/spotify/info', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL Spotify diperlukan' });
    }

    const trackMatch = url.match(/spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/i);
    const type = trackMatch ? trackMatch[1] : 'track';
    const id = trackMatch ? trackMatch[2] : '';

    let title = 'Spotify Audio Track';
    let artist = 'Spotify Artist';
    let thumbnailUrl = '';

    try {
      const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
      const response = await fetch(oembedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) {
        const data: any = await response.json();
        if (data.title) title = data.title;
        if (data.thumbnail_url) thumbnailUrl = data.thumbnail_url;
        if (data.author_name) artist = data.author_name;
      }
    } catch (e: any) {
      console.warn('Spotify oEmbed note:', e.message);
    }

    return res.json({
      success: true,
      type,
      id,
      title,
      artist,
      thumbnailUrl,
      downloadUrl: `https://spotidown.app/?url=${encodeURIComponent(url)}`
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Gagal memproses track Spotify' });
  }
});

// Gemini Chat Endpoint
app.post('/api/gemini/chat', async (req, res) => {
  try {
    const { messages, systemInstruction, model, temperature, customApiKey } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    // Supported models as requested:
    // - gemini-3.1-pro-preview : complex tasks
    // - gemini-3.5-flash : general tasks (default)
    // - gemini-3.1-flash-lite : fast tasks
    const validModels = ['gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'];
    const chosenModel = validModels.includes(model) ? model : 'gemini-3.5-flash';

    let ai: GoogleGenAI;
    if (customApiKey && typeof customApiKey === 'string' && customApiKey.trim().length > 0) {
      ai = new GoogleGenAI({ apiKey: customApiKey.trim() });
    } else {
      ai = getAIClient();
    }

    // Map conversation messages to Gemini format
    const contents = messages.map((m: { role: string; content: string }) => ({
      role: m.role === 'model' || m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }]
    }));

    const response = await ai.models.generateContent({
      model: chosenModel,
      contents: contents,
      config: {
        systemInstruction: systemInstruction ? String(systemInstruction) : undefined,
        temperature: typeof temperature === 'number' ? temperature : 0.7,
      }
    });

    const responseText = response.text || '';
    return res.json({
      text: responseText,
      model: chosenModel,
      usage: response.usageMetadata || null
    });
  } catch (error: any) {
    console.error('Gemini Chat API Error:', error);
    return res.status(500).json({
      error: error.message || 'Gagal memproses pesan dengan model Gemini AI',
      details: error.toString()
    });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Jovann Tools Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
