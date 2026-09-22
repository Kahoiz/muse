import {Collection} from 'discord.js';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import HttpApi from '../src/services/http-api.js';
import type Config from '../src/services/config.js';
import type PlayerManager from '../src/managers/player.js';
import type Player from '../src/services/player.js';
import {MediaSource, STATUS} from '../src/services/player-types.js';

const makeSong = (overrides: Record<string, unknown> = {}) => ({
  title: 'Never Gonna Give You Up',
  artist: 'Rick Astley',
  url: 'dQw4w9WgXcQ',
  length: 213,
  offset: 0,
  playlist: null,
  isLive: false,
  thumbnailUrl: 'https://example.com/thumb.jpg',
  source: MediaSource.Youtube,
  addedInChannelId: 'text-channel-id',
  requestedBy: 'user-id',
  ...overrides,
});

const makeVoiceChannel = () => ({
  id: 'voice-channel-id',
  name: 'Music',
  members: new Collection<string, any>([
    ['user-id', {id: 'user-id', displayName: 'benni', user: {bot: false}}],
    ['friend-id', {id: 'friend-id', displayName: 'friend', user: {bot: false}}],
    ['muse', {id: 'muse', displayName: 'Muse', user: {bot: true}}],
  ]),
});

const makeGuild = (id: string, name: string) => ({
  id,
  name,
  members: {
    cache: new Collection<string, any>([
      ['user-id', {id: 'user-id', displayName: 'benni'}],
    ]),
  },
});

const makePlayer = (overrides: Record<string, unknown> = {}) => ({
  status: STATUS.PLAYING,
  voiceConnection: {},
  loopCurrentSong: false,
  loopCurrentQueue: false,
  getCurrent: () => makeSong(),
  getQueue: () => [
    makeSong({title: 'Up next', url: 'abcdefghijk'}),
    makeSong({title: 'And then this', url: 'lmnopqrstuv', requestedBy: 'stranger-id'}),
  ],
  getCurrentChannel: () => makeVoiceChannel(),
  getPosition: () => 42,
  getVolume: () => 80,
  queueSize: () => 2,
  ...overrides,
}) as unknown as Player;

const makeApi = ({token = '', players = new Map<string, Player>()} = {}) => {
  const config = {
    HTTP_API_ENABLED: true,
    HTTP_API_HOST: '127.0.0.1',
    HTTP_API_PORT: 0,
    HTTP_API_TOKEN: token,
  } as unknown as Config;

  const client = {
    user: {id: 'bot-id', username: 'Muse'},
    isReady: () => true,
    uptime: 60_000,
    guilds: {
      cache: new Collection<string, any>([
        ['guild-1', makeGuild('guild-1', 'Alpha')],
        ['guild-2', makeGuild('guild-2', 'Beta')],
      ]),
    },
  } as any;

  const playerManager = {
    getExisting: (guildId: string) => players.get(guildId),
  } as unknown as PlayerManager;

  return new HttpApi(client, config, playerManager);
};

let api: HttpApi | null = null;

const start = async (options?: {token?: string; players?: Map<string, Player>}) => {
  api = makeApi(options);
  await api.start();
  return api.address;
};

beforeEach(() => {
  api = null;
});

afterEach(async () => {
  await api?.stop();
  api = null;
});

describe('HTTP API', () => {
  it('reports which guilds are playing and what song', async () => {
    const players = new Map<string, Player>([['guild-1', makePlayer()]]);
    const base = await start({players});

    const response = await fetch(`${base}/api/status`);
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.bot).toMatchObject({id: 'bot-id', username: 'Muse', ready: true, uptimeSeconds: 60});
    expect(body.summary).toMatchObject({guilds: 2, connected: 1, playing: 1, listeners: 2, queued: 2});
    expect(body.summary.nowPlaying).toBe('Never Gonna Give You Up');
    expect(body.summary.nowPlayingIn).toBe('Alpha');

    expect(body.playing).toHaveLength(1);
    expect(body.playing[0]).toMatchObject({
      id: 'guild-1',
      name: 'Alpha',
      status: 'playing',
      connected: true,
      volume: 80,
      voiceChannel: {id: 'voice-channel-id', name: 'Music', listeners: 2},
    });
    expect(body.playing[0].voiceChannel.listenerNames).toEqual(['benni', 'friend']);
    expect(body.playing[0].nowPlaying).toMatchObject({
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      source: 'youtube',
      lengthSeconds: 213,
      positionSeconds: 42,
    });
    expect(body.playing[0].queue).toMatchObject({length: 2});
    expect(body.playing[0].queue.nextUp.title).toBe('Up next');
    expect(body.playing[0].queue.items.map((song: any) => song.title)).toEqual(['Up next', 'And then this']);
  });

  it('resolves requester IDs to display names where the member is known', async () => {
    const players = new Map<string, Player>([['guild-1', makePlayer()]]);
    const base = await start({players});

    const body = await (await fetch(`${base}/api/status`)).json() as any;

    expect(body.playing[0].nowPlaying.requestedByName).toBe('benni');
    // Nobody cached for this ID, so the name is null rather than a guess.
    expect(body.playing[0].queue.items[1]).toMatchObject({requestedBy: 'stranger-id', requestedByName: null});
  });

  it('reports guilds without a player as idle', async () => {
    const base = await start();

    const body = await (await fetch(`${base}/api/status`)).json() as any;

    expect(body.playing).toHaveLength(0);
    expect(body.guilds.map((guild: any) => guild.status)).toEqual(['idle', 'idle']);
    expect(body.guilds[0]).toMatchObject({connected: false, nowPlaying: null, voiceChannel: null});
  });

  it('hides now playing info for a player that is connected but paused', async () => {
    const players = new Map<string, Player>([['guild-1', makePlayer({status: STATUS.PAUSED})]]);
    const base = await start({players});

    const body = await (await fetch(`${base}/api/status`)).json() as any;

    expect(body.summary.playing).toBe(0);
    expect(body.guilds[0].status).toBe('paused');
    expect(body.guilds[0].nowPlaying).not.toBeNull();
  });

  it('serves a single guild and 404s for unknown ones', async () => {
    const players = new Map<string, Player>([['guild-2', makePlayer()]]);
    const base = await start({players});

    const found = await fetch(`${base}/api/guilds/guild-2`);
    expect(found.status).toBe(200);
    expect((await found.json() as any).name).toBe('Beta');

    const missing = await fetch(`${base}/api/guilds/123456789`);
    expect(missing.status).toBe(404);
  });

  it('serves /health without a token and rejects unauthenticated API requests', async () => {
    const base = await start({token: 'secret-token'});

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect((await health.json() as any).status).toBe('ok');

    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    expect((await fetch(`${base}/api/status`, {headers: {authorization: 'Bearer wrong'}})).status).toBe(401);
  });

  it('accepts the token as a bearer header, an API key header, or a query parameter', async () => {
    const base = await start({token: 'secret-token'});

    expect((await fetch(`${base}/api/status`, {headers: {authorization: 'Bearer secret-token'}})).status).toBe(200);
    expect((await fetch(`${base}/api/status`, {headers: {'x-api-key': 'secret-token'}})).status).toBe(200);
    expect((await fetch(`${base}/api/status?token=secret-token`)).status).toBe(200);
  });

  it('rejects non-GET methods and unknown paths', async () => {
    const base = await start();

    const posted = await fetch(`${base}/api/status`, {method: 'POST'});
    expect(posted.status).toBe(405);
    expect(posted.headers.get('allow')).toBe('GET, HEAD');

    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('stops listening after stop()', async () => {
    const base = await start();

    await api?.stop();

    await expect(fetch(`${base}/health`)).rejects.toThrow();
  });
});
