const { Client, Intents, MessageEmbed } = require('discord.js');
const { Client: SSHClient } = require('ssh2');
const sqlite3 = require('sqlite3').verbose();
const util = require('util');

const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.DIRECT_MESSAGES] });
const prefix = '!';

// Connect to the SQLite database
const db = new sqlite3.Database('./ssh_configs.db', (err) => {
  if (err) {
    console.error('Failed to connect to the database:', err);
  } else {
    console.log('Connected to the database');
  }
});

// Create the SSH configs table if it doesn't exist
db.run(`CREATE TABLE IF NOT EXISTS ssh_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL
)`);

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

const activeSessions = new Map();

client.on('messageCreate', async (message) => {
  if (!message.guild) return;
  if (message.author.bot) return;
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'ping') {
    await message.reply('Pong!');
  } else if (command === 'hello') {
    await message.reply('Hello, world!');
  } else if (command === 'ssh') {
    const existingSession = activeSessions.get(message.author.id);

    if (existingSession) {
      await message.reply('You already have an active SSH session. Please end it before starting a new one.');
      return;
    }

    const dmChannel = await message.author.createDM();

    const useSavedInputs = await askToUseSavedInputs(message.author.id, dmChannel);

    let sshConfig = {
      host: null,
      port: null,
      username: null,
      password: null,
    };

    if (useSavedInputs) {
      const savedConfigs = await getSavedSSHConfigs(message.author.id);
      if (savedConfigs.length === 0) {
        await message.reply('No saved SSH configurations found. Please enter the SSH details manually.');
      } else {
        const selectedConfig = await selectSSHConfig(savedConfigs, dmChannel);
        sshConfig = selectedConfig;
      }
    } else {
      sshConfig = await promptSSHInputs(dmChannel);
      if (!sshConfig) {
        await message.reply('Invalid or incomplete SSH inputs. Please try again.');
        return;
      }

      const saveInputs = await askToSaveInputs(message.author.id, dmChannel);
      if (saveInputs) {
        await saveSSHConfig(message.author.id, sshConfig);
        await message.reply('SSH inputs saved successfully!');
      }
    }

    const ssh = new SSHClient();
    ssh.on('ready', () => {
      const session = { ssh, channel: null, message: null, output: [] };
      activeSessions.set(message.author.id, session);

      session.channel = ssh.shell((err, channel) => {
        if (err) {
          dmChannel.send(`Error starting SSH shell: ${err.message}`);
          session.ssh.end();
          activeSessions.delete(message.author.id);
          return;
        }

        const embed = new MessageEmbed()
          .setTitle(`SSH session for server "${sshConfig.host}"`)
          .setDescription('Initializing session...')
          .setColor('#007fff');

        dmChannel.send({ embeds: [embed] }).then((sentMessage) => {
          session.message = sentMessage;

          channel.on('data', (data) => {
            const output = data.toString();
            session.output.push(output);
            if (output.includes('\n')) {
              const formattedOutput = session.output.join('');
              session.output = [];
              dmChannel.send(`\`\`\`${formattedOutput}\`\`\``);
            }
          });

          channel.on('close', () => {
            dmChannel.send('SSH session closed.');
            session.ssh.end();
            activeSessions.delete(message.author.id);
          });

          channel.stderr.on('data', (data) => {
            const output = data.toString();
            dmChannel.send(`\`\`\`${output}\`\`\``);
          });

          channel.stdin.write('ls\n'); // Example command, replace with your desired commands
        });
      });
    });

    ssh.on('error', (err) => {
      dmChannel.send(`SSH connection error: ${err.message}`);
    });

    ssh.on('end', () => {
      activeSessions.delete(message.author.id);
    });

    ssh.connect({
      host: sshConfig.host,
      port: sshConfig.port,
      username: sshConfig.username,
      password: sshConfig.password,
    });
  }
});

async function askToUseSavedInputs(userId, channel) {
  const savedConfigs = await getSavedSSHConfigs(userId);
  if (savedConfigs.length === 0) return false;

  const embed = new MessageEmbed()
    .setTitle('SSH Configuration')
    .setDescription('Do you want to use your saved SSH inputs?')
    .addField('Saved Configurations', formatSavedSSHConfigs(savedConfigs), false)
    .addField('Options', 'Send ✅ to use saved inputs\nSend ❌ to enter new inputs', false)
    .setColor('#007fff');

  const message = await channel.send({ embeds: [embed] });

  const filter = (msg) => msg.author.id === channel.recipient.id && ['✅', '❌'].includes(msg.content.trim().toLowerCase());
  const collected = await channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });

  const response = collected.first().content.trim().toLowerCase();

  if (response === '✅') {
    return true;
  } else if (response === '❌') {
    return false;
  }
}

async function getSavedSSHConfigs(userId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM ssh_configs WHERE user_id = ?', [userId], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

function formatSavedSSHConfigs(configs) {
  let result = '';
  configs.forEach((config, index) => {
    result += `${index + 1}. Host: ${config.host}, Port: ${config.port}, Username: ${config.username}\n`;
  });
  return result || 'No saved SSH configurations found.';
}

async function selectSSHConfig(configs, channel) {
  const embed = new MessageEmbed()
    .setTitle('SSH Configuration')
    .setDescription('Select the saved SSH configuration you want to use by entering the corresponding number:')
    .addField('Saved Configurations', formatSavedSSHConfigs(configs), false)
    .setColor('#007fff');

  const message = await channel.send({ embeds: [embed] });

  const filter = (msg) => msg.author.id === channel.recipient.id && /^\d+$/.test(msg.content.trim());
  const collected = await channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });

  const selectedIndex = parseInt(collected.first().content.trim()) - 1;
  if (selectedIndex < 0 || selectedIndex >= configs.length) {
    await channel.send('Invalid selection.');
    return null;
  }

  return configs[selectedIndex];
}

async function promptSSHInputs(channel) {
  const embed = new MessageEmbed()
    .setTitle('SSH Configuration')
    .setDescription('Enter the SSH details:')
    .addField('Host', 'Enter the hostname or IP address', false)
    .addField('Port', 'Enter the port number', false)
    .addField('Username', 'Enter the SSH username', false)
    .addField('Password', 'Enter the SSH password', false)
    .setColor('#007fff');

  const message = await channel.send({ embeds: [embed] });

  const filter = (msg) => msg.author.id === channel.recipient.id;
  const collected = await channel.awaitMessages({ filter, max: 4, time: 30000, errors: ['time'] });

  const host = collected.get(message.id).content.trim();
  const port = parseInt(collected.get(collected.lastKey()).content.trim());
  const username = collected.get(collected.lastKey(-2)).content.trim();
  const password = collected.get(collected.lastKey(-3)).content.trim();

  if (!host || !port || !username || !password) {
    return null;
  }

  return { host, port, username, password };
}

async function askToSaveInputs(userId, channel) {
  const embed = new MessageEmbed()
    .setTitle('SSH Configuration')
    .setDescription('Do you want to save these SSH inputs for future use?')
    .addField('Options', 'Send ✅ to save inputs\nSend ❌ to not save inputs', false)
    .setColor('#007fff');

  const message = await channel.send({ embeds: [embed] });

  const filter = (msg) => msg.author.id === channel.recipient.id && ['✅', '❌'].includes(msg.content.trim().toLowerCase());
  const collected = await channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });

  const response = collected.first().content.trim().toLowerCase();

  if (response === '✅') {
    return true;
  } else if (response === '❌') {
    return false;
  }
}

async function saveSSHConfig(userId, config) {
  return new Promise((resolve, reject) => {
    const { host, port, username, password } = config;
    db.run('INSERT INTO ssh_configs (user_id, host, port, username, password) VALUES (?, ?, ?, ?, ?)',
      [userId, host, port, username, password],
      (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
  });
}

const token = 'MTExMDI3MzI5MDY1MzY3NTU1MQ.GPZBH9.Qut3sr1BKdBOyTFvXgrdjSrGQAD5QrquXe29YE';
client.login(token);
