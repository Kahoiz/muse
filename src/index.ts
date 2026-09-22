import makeDir from 'make-dir';
import path from 'path';
import container from './inversify.config.js';
import {TYPES} from './types.js';
import Bot from './bot.js';
import Config from './services/config.js';
import FileCacheProvider from './services/file-cache.js';
import HttpApi from './services/http-api.js';
import prepareYtDlp from './utils/prepare-yt-dlp.js';

const bot = container.get<Bot>(TYPES.Bot);

const startBot = async () => {
  // Create data directories if necessary
  const config = container.get<Config>(TYPES.Config);

  await makeDir(config.DATA_DIR);
  await makeDir(config.CACHE_DIR);
  await makeDir(path.join(config.CACHE_DIR, 'tmp'));

  await container.get<FileCacheProvider>(TYPES.FileCache).cleanup();
  await prepareYtDlp(config);

  await bot.register();

  if (config.HTTP_API_ENABLED) {
    const httpApi = container.get<HttpApi>(TYPES.Services.HttpApi);

    try {
      await httpApi.start();
      console.log(`🌐 HTTP API listening on ${httpApi.address}`);
    } catch (error) {
      // The API is auxiliary: a port conflict shouldn't take the music bot down.
      console.error(`Could not start HTTP API on ${httpApi.address}:`, error);
      return;
    }

    let isShuttingDown = false;
    const shutdown = async () => {
      if (isShuttingDown) {
        return;
      }

      isShuttingDown = true;
      await httpApi.stop();
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
};

export {startBot};
