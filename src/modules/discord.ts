import Websocket from 'ws';
import ReconnectingWebSocket from 'reconnecting-websocket';
import jsonfile from 'jsonfile';
import fetch, {Response} from 'node-fetch';
import {
    Channel, Guild, WebhookConfig,
} from '../interfaces/interfaces';
import {discordToken, serverId, headers, redisUri} from '../util/env';
import {RESTProducer} from "@synzen/discord-rest";
import RESTConsumer from "@synzen/discord-rest/dist/RESTConsumer";

const producer = new RESTProducer(redisUri!);
const consumer = new RESTConsumer(redisUri!, '${discordToken}');

const options = {
    WebSocket: Websocket, // custom WebSocket constructor
    connectionTimeout: 1000,
    maxRetries: 10,
};

export const createWebhook = async (channelId: string): Promise<string> => fetch(`https://discord.com/api/v8/channels/${channelId}/webhooks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
        name: channelId,
    }),
}).then((res) => res.json())
    .then((json) => `https://discord.com/api/v8/webhooks/${json.id}/${json.token}`);


export const executeWebhook = async ({
                                         content, embeds, username, url, avatar,
                                     }: WebhookConfig): Promise<Response> => fetch(url, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
    },
    body: JSON.stringify({
        content,
        embeds,
        username,
        avatar_url: avatar,
    }),
});

export const createChannel = async (name: string, pos: number, newId: string, parentId?: string): Promise<Channel> => fetch(`https://discord.com/api/v8/guilds/${newId}/channels`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
        name,
        parent_id: parentId,
        position: pos,
    }),
}).then((res) => res.json());

export const listen = async (): Promise<void> => {
    const serverMap = jsonfile.readFileSync('./map.json');
    const socket = new ReconnectingWebSocket('wss://gateway.discord.gg/?v=6&encoding=json', [], options);
    let authenticated = false;

    socket.addEventListener('open', () => {
        authenticated = false;
        console.log('Connected to Discord API');
    });
    socket.addEventListener('close', () => {
        authenticated = false;
        console.log('Disconnected from Discord API');
    });
    socket.addEventListener('message', (data: any) => {
        const message = JSON.parse(data.data.toString());

        switch (message.op) {
            case 10:
                socket.send(JSON.stringify({
                    op: 1,
                    d: message.s,
                }));
                setInterval(() => {
                    socket.send(JSON.stringify({
                        op: 1,
                        d: message.s,
                    }));
                }, message.d.heartbeat_interval);
                break;
            case 11:
                if (!authenticated) {
                    socket.send(JSON.stringify({
                        op: 2,
                        d: {
                            token: discordToken,
                            properties: {
                                $os: 'Windows',
                                $browser: 'Chrome',
                                $device: '',
                            },
                        },
                    }));
                    authenticated = true;
                }
                break;
            case 0:
                if (message.t === 'MESSAGE_CREATE' && message.d.guild_id === serverId) {
                    console.log(data.toString());
                    const {content, embeds, channel_id: channelId} = message.d;
                    let {
                        avatar, username, id, discriminator,
                    } = message.d.author;
                    const avatarUrl = `https://cdn.discordapp.com/avatars/${id}/${avatar}.png`;
                    const webhookUrl = serverMap[channelId];
                    const hookContent: WebhookConfig = {
                        content,
                        embeds,
                        username: `${username}#${discriminator}`,
                        url: webhookUrl,
                        avatar: avatarUrl,
                    };
                    let avatar_url = avatar;
                    console.log(JSON.stringify({
                        content,
                        embeds,
                        username,
                        avatar_url: avatar,
                    }));
                    producer
                        .enqueue(webhookUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                content,
                                embeds,
                                username,
                                avatar_url: avatarUrl,
                            }),
                        })
                        .then((response) => {
                            // Status code (200, 400, etc.)
                            //let res = <Response><unknown>response;
                        })
                        .catch(console.error);
                    // const res = await executeWebhook(hookContent);
                    // console.log(res);
                    // //console.log(JSON.stringify(res.headers));
                    // res.headers.forEach((value, key) => {
                    //   console.log([key, value]);
                    // });
                    //res.headers.forEach(header => console.log(header));
                    //executeWebhook(hookContent);
                }
                break;
            default:
                break;
        }
    });
};

export const getChannels = async (): Promise<Channel[]> => fetch(`https://discord.com/api/v8/guilds/${serverId}/channels`, {
    method: 'GET',
    headers,
}).then((res) => res.json())
    .then((json: Channel[]) => json);

export const createServer = async (channels: Channel[]): Promise<void> => {
    console.log('Creating mirror server...');
    const cleanedChannels = channels.map(({
                                              id, parent_id, guild_id, last_message_id, ...rest
                                          }) => rest);
    const categories = cleanedChannels.filter((channel) => channel.type === 4);
    const body = {
        name: 'mirror',
        channels: categories,
    };
    const serverMap = new Map();
    const serverResp: Response = await fetch('https://discord.com/api/v8/guilds', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    const server: Guild = await serverResp.json();
    const newId = server.id;

    serverMap.set('serverId', newId);

    const channelResp = await fetch(`https://discord.com/api/v8/guilds/${newId}/channels`, {
        headers: {
            'Content-Type': 'application/json',
            Authorization: discordToken!,
        },
    });

    const serverChannels: Channel[] = await channelResp.json();

    return new Promise(async (resolve) => {
        for (const channel of channels) {
            try {
                if (channel.parent_id && channel.type !== 2) {
                    const parentChannel = channels.find((chan) => chan.id === channel.parent_id);
                    if (parentChannel) {
                        const newParentChannel = serverChannels.find((chan) => chan.name === parentChannel.name);
                        if (newParentChannel) {
                            const newChannel = await createChannel(
                                channel.name,
                                channel.position,
                                newId,
                                newParentChannel.id,
                            );
                            const newWebhook = await createWebhook(newChannel.id);
                            serverMap.set(channel.id, newWebhook);
                        }
                    }
                }
            } catch (err) {
            }
        }
        jsonfile.writeFileSync('./map.json', Object.fromEntries(serverMap));
        resolve();
    });
};

export const updateServer = async (channels: Channel[]): Promise<void> => {
    console.log('Updating mirror server...');
    const serverMapTemp = jsonfile.readFileSync('./map.json');
    const serverMap = new Map();
    for (let value in serverMapTemp) {
        serverMap.set(value, serverMapTemp[value])
    }
    const cleanedChannels = channels.map(({
                                              id, parent_id, guild_id, last_message_id, ...rest
                                          }) => rest);
    // const categories = cleanedChannels.filter((channel) => channel.type === 4);
    // const body = {
    //     name: 'mirror',
    //     channels: categories,
    // };
    // const serverResp: Response = await fetch('https://discord.com/api/v8/guilds', {
    //     method: 'POST',
    //     headers,
    //     body: JSON.stringify(body),
    // });

    const newId = serverMap.get('serverId');

    const channelResp = await fetch(`https://discord.com/api/v8/guilds/${newId}/channels`, {
        headers: {
            'Content-Type': 'application/json',
            Authorization: discordToken!,
        },
    });

    const serverChannels: Channel[] = await channelResp.json();

    console.log(serverChannels);

    return new Promise(async (resolve) => {
        for (const channel of channels) {
            try {
                if (channel.parent_id && channel.type !== 2) {
                    const parentChannel = channels.find((chan) => chan.id === channel.parent_id);
                    if (parentChannel) {
                        const newParentChannel = serverChannels.find((chan) => chan.name === parentChannel.name);
                        if (newParentChannel) {
                            console.log(channel);
                            if (serverMap.has(channel.id)) {
                                console.log('Channel Already Exists');
                            } else {
                                console.log('Creating channel ' + channel.name);
                                const newChannel = await createChannel(
                                    channel.name,
                                    channel.position,
                                    newId,
                                    newParentChannel.id,
                                );
                                const newWebhook = await createWebhook(newChannel.id);
                                serverMap.set(channel.id, newWebhook);
                            }
                        }
                    }
                }
            } catch (err) {
                console.log(err);
            }
        }
        jsonfile.writeFileSync('./map.json', Object.fromEntries(serverMap));
        resolve();
    });
};
