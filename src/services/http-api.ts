import http from 'http';
import {timingSafeEqual} from 'crypto';
import {Client, Guild, VoiceChannel} from 'discord.js';
import getYouTubeID from 'get-youtube-id';
import {inject, injectable} from 'inversify';
import {TYPES} from '../types.js';
import Config from './config.js';
import PlayerManager from '../managers/player.js';
import type Player from './player.js';
import {MediaSource, QueuedSong, STATUS} from './player-types.js';
import {getSizeWithoutBots} from '../utils/channels.js';

const STATUS_NAMES: Record<STATUS, string> = {
  [STATUS.PLAYING]: 'playing',
  [STATUS.PAUSED]: 'paused',
  [STATUS.IDLE]: 'idle',
};

const SOURCE_NAMES: Record<MediaSource, string> = {
  [MediaSource.Youtube]: 'youtube',
  [MediaSource.HLS]: 'hls',
  [MediaSource.SoundCloud]: 'soundcloud',
};

const getSongUrl = ({url, offset, source}: QueuedSong): string => {
  if (source !== MediaSource.Youtube) {
    return url;
  }

  const youtubeId = url.length === 11 ? url : getYouTubeID(url) ?? '';

  return `https://www.youtube.com/watch?v=${youtubeId}${offset === 0 ? '' : `&t=${offset}`}`;
};

/**
 * Muse only stores the requester's ID. Members who are in a voice channel are
 * cached thanks to the voice state intent, so a name is usually available.
 */
type NameResolver = (userId: string) => string | null;

const serializeSong = (song: QueuedSong, resolveName: NameResolver) => ({
  title: song.title,
  artist: song.artist,
  url: getSongUrl(song),
  source: SOURCE_NAMES[song.source],
  lengthSeconds: song.isLive ? null : song.length,
  isLive: song.isLive,
  thumbnailUrl: song.thumbnailUrl,
  requestedBy: song.requestedBy,
  requestedByName: resolveName(song.requestedBy),
  playlist: song.playlist ? {title: song.playlist.title, source: song.playlist.source} : null,
});

// Enough for a dashboard to list the queue without sending a 500-song payload.
const MAX_QUEUE_ITEMS = 25;

const serializeVoiceChannel = (channel: VoiceChannel | undefined) => {
  if (!channel) {
    return null;
  }

  const humans = [...channel.members.values()].filter(member => !member.user.bot);

  return {
    id: channel.id,
    name: channel.name,
    listeners: getSizeWithoutBots(channel),
    listenerNames: humans.map(member => member.displayName),
  };
};

export const serializeGuild = (guild: Guild, player: Player | undefined) => {
  const resolveName: NameResolver = userId => guild.members.cache.get(userId)?.displayName ?? null;
  const currentSong = player?.getCurrent() ?? null;
  const upcoming = player?.getQueue() ?? [];
  const status = player ? STATUS_NAMES[player.status] : 'idle';
  const isConnected = Boolean(player?.voiceConnection);

  return {
    id: guild.id,
    name: guild.name,
    // A guild without a player has never been asked to play anything this session.
    status: isConnected ? status : 'idle',
    connected: isConnected,
    voiceChannel: isConnected ? serializeVoiceChannel(player?.getCurrentChannel()) : null,
    nowPlaying: isConnected && currentSong ? {
      ...serializeSong(currentSong, resolveName),
      positionSeconds: player?.getPosition() ?? 0,
    } : null,
    queue: {
      length: upcoming.length,
      nextUp: upcoming[0] ? serializeSong(upcoming[0], resolveName) : null,
      items: upcoming.slice(0, MAX_QUEUE_ITEMS).map(song => serializeSong(song, resolveName)),
    },
    volume: player?.getVolume() ?? null,
    loop: {
      song: player?.loopCurrentSong ?? false,
      queue: player?.loopCurrentQueue ?? false,
    },
  };
};

type SerializedGuild = ReturnType<typeof serializeGuild>;

interface JsonResponse {
  statusCode: number;
  body: unknown;
  headers?: Record<string, string>;
}

export const buildStatusPayload = (client: Client, playerManager: PlayerManager) => {
  const guilds: SerializedGuild[] = client.guilds.cache
    .map(guild => serializeGuild(guild, playerManager.getExisting(guild.id)))
    .sort((a, b) => a.name.localeCompare(b.name));

  const playing = guilds.filter(guild => guild.status === 'playing');

  return {
    bot: {
      id: client.user?.id ?? null,
      username: client.user?.username ?? null,
      // The bot's own Discord avatar, so a dashboard can use it as the icon.
      avatarUrl: client.user?.displayAvatarURL({size: 128}) ?? null,
      ready: client.isReady(),
      uptimeSeconds: client.uptime === null ? null : Math.floor(client.uptime / 1000),
    },
    summary: {
      guilds: guilds.length,
      connected: guilds.filter(guild => guild.connected).length,
      playing: playing.length,
      listeners: guilds.reduce((total, guild) => total + (guild.voiceChannel?.listeners ?? 0), 0),
      queued: guilds.reduce((total, guild) => total + guild.queue.length, 0),
      // Convenience fields for single-line dashboard widgets.
      nowPlaying: playing[0]?.nowPlaying?.title ?? null,
      nowPlayingIn: playing[0]?.name ?? null,
    },
    playing,
    guilds,
  };
};

@injectable()
export default class HttpApi {
  private readonly client: Client;
  private readonly config: Config;
  private readonly playerManager: PlayerManager;
  private server: http.Server | null = null;

  constructor(
    @inject(TYPES.Client) client: Client,
    @inject(TYPES.Config) config: Config,
    @inject(TYPES.Managers.Player) playerManager: PlayerManager,
  ) {
    this.client = client;
    this.config = config;
    this.playerManager = playerManager;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener('listening', onListening);
        this.server = null;
        reject(error);
      };

      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.config.HTTP_API_PORT, this.config.HTTP_API_HOST);
    });

    // Once listening, don't let a late socket error take down the process.
    server.on('error', error => {
      console.error('HTTP API error:', error);
    });
  }

  async stop(): Promise<void> {
    const {server} = this;

    if (!server) {
      return;
    }

    this.server = null;

    await new Promise<void>(resolve => {
      server.close(() => {
        resolve();
      });
      // Available on Node 18.2+; @types/node is older than the runtime we target.
      (server as http.Server & {closeAllConnections?: () => void}).closeAllConnections?.();
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.sendJson(req, res, this.route(req));
  }

  private route(req: http.IncomingMessage): JsonResponse {
    let url: URL;

    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      return {statusCode: 400, body: {error: 'bad request'}};
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return {statusCode: 405, body: {error: 'method not allowed'}, headers: {Allow: 'GET, HEAD'}};
    }

    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Unauthenticated so it can be used as a container healthcheck.
    if (path === '/health') {
      return {statusCode: 200, body: {status: this.client.isReady() ? 'ok' : 'starting'}};
    }

    if (!this.isAuthorized(req, url)) {
      return {statusCode: 401, body: {error: 'unauthorized'}, headers: {'WWW-Authenticate': 'Bearer'}};
    }

    if (path === '/' || path === '/api' || path === '/api/status') {
      return {statusCode: 200, body: buildStatusPayload(this.client, this.playerManager)};
    }

    if (path === '/api/guilds') {
      return {statusCode: 200, body: {guilds: buildStatusPayload(this.client, this.playerManager).guilds}};
    }

    if (path === '/api/now-playing') {
      return {statusCode: 200, body: {playing: buildStatusPayload(this.client, this.playerManager).playing}};
    }

    const guildMatch = /^\/api\/guilds\/([^/]{1,64})$/.exec(path);
    if (guildMatch) {
      const guild = this.client.guilds.cache.get(decodeURIComponent(guildMatch[1]));

      if (!guild) {
        return {statusCode: 404, body: {error: 'guild not found'}};
      }

      return {statusCode: 200, body: serializeGuild(guild, this.playerManager.getExisting(guild.id))};
    }

    return {statusCode: 404, body: {error: 'not found'}};
  }

  private isAuthorized(req: http.IncomingMessage, url: URL): boolean {
    const expected = this.config.HTTP_API_TOKEN;

    if (expected === '') {
      return true;
    }

    const header = req.headers.authorization ?? '';
    const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1];
    const provided = bearer
      ?? (Array.isArray(req.headers['x-api-key']) ? req.headers['x-api-key'][0] : req.headers['x-api-key'])
      ?? url.searchParams.get('token')
      ?? '';

    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);

    if (expectedBuffer.length !== providedBuffer.length) {
      return false;
    }

    return timingSafeEqual(expectedBuffer, providedBuffer);
  }

  private sendJson(req: http.IncomingMessage, res: http.ServerResponse, {statusCode, body, headers = {}}: JsonResponse): void {
    const payload = JSON.stringify(body);

    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      ...headers,
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    res.end(payload);
  }

  /**
   * The address the server is actually bound to, falling back to the
   * configured one before it starts listening.
   */
  get address(): string {
    const boundAddress = this.server?.address();
    const port = boundAddress && typeof boundAddress === 'object' ? boundAddress.port : this.config.HTTP_API_PORT;

    return `http://${this.config.HTTP_API_HOST}:${port}`;
  }
}
