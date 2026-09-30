require('dotenv').config();

const express = require('express');
const path = require('path');
const bytes = require('bytes');
const NodeCache = require('node-cache');
const axios = require('axios');
const multer = require('multer');
const {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  PutObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
const PORT = process.env.PORT || 3000;

// 管理密码
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

// ===== R2 (S3 兼容) 配置 =====
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const ALLOWED_EXT = ['.mp3', '.wav', '.flac', '.m4a'];
const FILENAME_REGEX = /^[a-zA-Z0-9\u4e00-\u9fa5][a-zA-Z0-9\u4e00-\u9fa5\s\-_.]+\.(mp3|wav|flac|m4a)$/;

function getContentType(ext) {
  const contentTypes = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
  };
  return contentTypes[ext] || 'application/octet-stream';
}

function formatFileSize(sizeBytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = sizeBytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(2)}${units[unitIndex]}`;
}

function buildPublicUrl(key) {
  return `${R2_PUBLIC_URL}/${encodeURIComponent(key)}`;
}

async function listAllObjects() {
  let objects = [];
  let continuationToken;
  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        ContinuationToken: continuationToken,
      })
    );
    objects = objects.concat(resp.Contents || []);
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects.filter((o) => ALLOWED_EXT.includes(path.extname(o.Key).toLowerCase()));
}

const cache = new NodeCache({ stdTTL: 7200, checkperiod: 120, maxKeys: 500 });
const stats = { totalBytes: 0, requests: 0 };

app.set('json spaces', 2);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// 解析 JSON 请求体
app.use(express.json());

// 前端静态文件
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ===== 直链 / 播放 =====
app.get('/music/:filename', async (req, res) => {
  const filename = req.params.filename;

  if (!FILENAME_REGEX.test(filename)) {
    return res.status(400).send('Invalid filename');
  }

  let info = cache.get(filename);
  if (!info) {
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: filename }));
      info = { size: head.ContentLength, exists: true };
      cache.set(filename, info);
    } catch (err) {
      return res.status(404).send('File not found');
    }
  }

  stats.requests += 1;
  res.redirect(302, buildPublicUrl(filename));
});

app.get('/stats', (req, res) => {
  res.json({
    totalTransferred: bytes(stats.totalBytes),
    totalRequests: stats.requests,
    note: '播放/下载流量已直接由 R2 提供，此处仅统计管理类请求',
  });
});

// ===== 从远程 URL 下载音乐（需要密码）=====
app.get('/api/download', async (req, res) => {
  const { url, name, password } = req.query;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized: Invalid password' });
  }

  if (!url) {
    return res.status(400).json({ error: 'Please provide a music url' });
  }

  const urlFileName = decodeURIComponent(path.basename(url));
  const urlExt = path.extname(urlFileName).toLowerCase();
  if (!ALLOWED_EXT.includes(urlExt)) {
    return res.status(400).json({ error: 'Unsupported file format' });
  }

  const fullName = name ? name + urlExt : urlFileName;
  if (!FILENAME_REGEX.test(fullName)) {
    return res.status(400).json({ error: 'filename is wrong' });
  }

  try {
    await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: fullName }));
    return res.status(200).json({ warning: 'The song already exists', url: buildPublicUrl(fullName) });
  } catch (err) {
    // 不存在，继续
  }

  res.json({
    success: true,
    message: 'The song added to download list successfully',
    filename: fullName,
    futureUrl: buildPublicUrl(fullName),
  });

  try {
    const response = await axios({
      method: 'GET',
      url,
      timeout: 300000,
      responseType: 'stream',
    });

    const uploader = new Upload({
      client: s3,
      params: {
        Bucket: R2_BUCKET,
        Key: fullName,
        Body: response.data,
        ContentType: getContentType(urlExt),
      },
    });

    await uploader.done();
    cache.del(fullName);
    console.log(`Uploaded to R2: ${fullName}`);
  } catch (error) {
    console.error(`Download/upload failed for ${fullName}:`, error.message);
  }
});

// ===== 直接上传本地文件到 R2（经过 Node 中转，适合小文件，需要密码）=====
app.post('/api/upload', upload.single('music'), async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized: Invalid password' });
    }

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      return res.status(400).json({ error: 'Unsupported file format' });
    }

    const newFilename = file.originalname;

    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: newFilename,
        Body: file.buffer,
        ContentType: getContentType(ext),
      })
    );

    cache.del(newFilename);

    res.json({
      success: true,
      filename: newFilename,
      url: buildPublicUrl(newFilename),
    });
  } catch (err) {
    res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

// ===== 新增：获取预签名上传链接（浏览器直传R2，不经过Node中转，需要密码）=====
app.get('/api/upload-url', async (req, res) => {
  try {
    const { filename, password } = req.query;

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized: Invalid password' });
    }

    if (!filename || !FILENAME_REGEX.test(filename)) {
      return res.status(400).json({ error: 'Invalid or missing filename' });
    }

    const ext = path.extname(filename).toLowerCase();

    const command = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: filename,
      ContentType: getContentType(ext),
    });

    // 10 分钟有效期，够传一首歌了
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 600 });

    res.json({
      success: true,
      uploadUrl,
      publicUrl: buildPublicUrl(filename),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate upload URL', details: err.message });
  }
});

// ===== 获取音乐列表 =====
app.get('/api/music/list', async (req, res) => {
  try {
    const musicFiles = await listAllObjects();

    const musicList = musicFiles.map((o) => ({
      filename: o.Key,
      url: buildPublicUrl(o.Key),
      size: formatFileSize(o.Size),
      extension: path.extname(o.Key).slice(1).toUpperCase(),
      lastModified: o.LastModified ? o.LastModified.toLocaleString() : '',
    }));

    res.json({ total: musicList.length, data: musicList });
  } catch (error) {
    res.status(500).json({ error: 'Get music list failed', details: error.message });
  }
});

// ===== 删除音乐（需要管理密码）=====
app.post('/api/delete/music', async (req, res) => {
  const { names, password, all } = { ...req.query, ...req.body };

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized: Invalid password' });
  }

  try {
    const allMusic = await listAllObjects();
    let filesToDelete = [];

    if (all === 'true') {
      filesToDelete = allMusic.map((o) => o.Key);
    } else if (names) {
      const nameList = typeof names === 'string' ? names.split(',') : names;
      filesToDelete = allMusic
        .filter((o) => {
          const base = path.basename(o.Key, path.extname(o.Key));
          const songNamePart = base.split('-')[0].trim().toLowerCase();
          return nameList.some((n) => songNamePart === n.trim().toLowerCase());
        })
        .map((o) => o.Key);
    } else {
      return res.status(400).json({ error: 'Please provide names parameter or set all=true' });
    }

    if (filesToDelete.length === 0) {
      return res.status(404).json({ error: 'No matching songs found' });
    }

    await s3.send(
      new DeleteObjectsCommand({
        Bucket: R2_BUCKET,
        Delete: { Objects: filesToDelete.map((Key) => ({ Key })) },
      })
    );

    filesToDelete.forEach((key) => cache.del(key));

    res.json({
      success: true,
      message: `Deleted ${filesToDelete.length} song(s)`,
      deletedFiles: filesToDelete,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete song(s)', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`music service is running on port ${PORT}`);
  if (!R2_PUBLIC_URL) {
    console.warn('警告: 未设置 R2_PUBLIC_URL，播放直链将无法正常生成');
  }
});
