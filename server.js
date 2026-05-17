require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const prisma = require('./lib/prisma');
const { syncEnvProviders } = require('./lib/provider');
const proxyRoute = require('./routes/proxy');
const adminRoute = require('./routes/admin');

const PORT = process.env.PORT || 3000;

async function start() {
  // 1. 同步环境变量 Provider 到数据库
  try {
    await syncEnvProviders(process.env.FALLBACK_PROVIDERS);
  } catch (err) {
    console.error('[Startup] Failed to sync env providers:', err.message);
  }

  // 2. 初始化 Express
  const app = express();

  // 3. 中间件
  app.set('trust proxy', 1);
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // 4. 路由
  app.use(proxyRoute);
  app.use('/admin', adminRoute);

  // 5. 启动
  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);

    if (process.env.ADMIN_USERNAME) {
      console.log('[Admin] Authentication enabled');
    } else {
      console.log('[Admin] No ADMIN_USERNAME set, admin panel is open');
    }

    if (!process.env.FALLBACK_PROVIDERS) {
      console.log('[Provider] No FALLBACK_PROVIDERS set, configure providers via admin panel');
    }
  });

  // 优雅关闭
  process.on('SIGINT', async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});