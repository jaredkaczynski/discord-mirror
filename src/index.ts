import fs from 'fs';
import { listen, createServer, updateServer, getChannels } from './modules/discord';

if (fs.existsSync('./map.json')) {
  getChannels().then((channels) => updateServer(channels)).then(() => listen());
} else {
  getChannels().then((channels) => createServer(channels)).then(() => listen());
}
