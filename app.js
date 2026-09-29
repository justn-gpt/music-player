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

const app = express();
const PORT = process.env.PORT || 3000;

// 管理密码（与原来一致）
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

// ===== R2 (S3 兼容) 配置 =====
// R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY: 在 CF Dashboard -> R2 -> 管理 API 令牌 中创建
// R2_BUCKET: 桶名
// R2_PUBLIC_URL: 桶绑定的公开访问域名，例如 https://music-cdn.yourdomain.com（不要带结尾斜杠）
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
// 与原项目一致的文件名合法性校验
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

// 列举桶内全部对象（自动翻页）
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

// 元数据缓存（存在性/大小），TTL 2 小时
const cache = new NodeCache({ stdTTL: 7200, checkperiod: 120, maxKeys: 500 });

// 流量统计（现在仅统计经过 Node 的管理类请求，播放/下载流量已转移到 R2，不再计入）
const stats = { totalBytes: 0, requests: 0 };

app.set('json spaces', 2);

// CORS 中间件
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// 解析 JSON 请求体（前端删除功能用 JSON body 发送参数，之前少了这一步导致读不到）
app.use(express.json());

// 前端静态文件（网页界面）
app.use(express.static(path.join(__dirname, 'public')));

// 上传中间件：内存存储，拿到 buffer 后直接传 R2，不落本地盘
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

// ===== 直链 / 播放：302 跳转到 R2 公开地址 =====
// 播放流量完全由 R2 承担，Node 只做一次存在性校验（走缓存）
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

// 统计接口
app.get('/stats', (req, res) => {
  res.json({
    totalTransferred: bytes(stats.totalBytes),
    totalRequests: stats.requests,
    note: '播放/下载流量已直接由 R2 提供，此处仅统计管理类请求',
  });
});

// ===== 从远程 URL 下载音乐，直接流式写入 R2（不经过本地磁盘）=====
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

  // 已存在则直接返回
  try {
    await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: fullName }));
    return res.status(200).json({ warning: 'The song already exists', url: buildPublicUrl(fullName) });
  } catch (err) {
    // 不存在，继续走下载流程
  }

  res.json({
    success: true,
    message: 'The song added to download list successfully',
    filename: fullName,
    futureUrl: buildPublicUrl(fullName),
  });

  // 后台异步：拉取远程文件并流式上传到 R2
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

// ===== 直接上传本地文件到 R2 =====
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
  // 前端用 JSON body 发送参数，这里同时兼容 query string，防止以后有别的调用方式
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

    // R2/S3 一次最多删除 1000 个对象，个人使用场景足够
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

// 启动服务器
app.listen(PORT, () => {
  console.log(`music service is running on port ${PORT}`);
  if (!R2_PUBLIC_URL) {
    console.warn('警告: 未设置 R2_PUBLIC_URL，播放直链将无法正常生成');
  }
});
