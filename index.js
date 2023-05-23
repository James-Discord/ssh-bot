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
            session.output.push(data.toString());
          });

          channel.on('close', () => {
            embed.setDescription('SSH session terminated.');
            embed.setColor('#ff0000');
            session.message.edit({ embeds: [embed] });

            session.ssh.end();
            activeSessions.delete(message.author.id);
          });
        });
      });
    });

    ssh.on('error', (err) => {
      dmChannel.send(`SSH connection error: ${err.message}`);
      ssh.end();
    });

    try {
      await ssh.connect(sshConfig);
    } catch (err) {
      dmChannel.send(`SSH connection error: ${err.message}`);
    }
  }
});

// Function to ask the user if they want to use saved SSH inputs
async function askToUseSavedInputs(userId, channel) {
  const savedConfigs = await getSavedSSHConfigs(userId);
  if (savedConfigs.length === 0) return false;

  const embed = new MessageEmbed()
    .setTitle('SSH Configuration')
    .setDescription('Do you want to use your saved SSH inputs?')
    .addField('Saved Configurations', formatSavedSSHConfigs(savedConfigs), false)
    .addField('Options', 'React with ✅ to use saved inputs\nReact with ❌ to enter new inputs', false)
    .setColor('#007fff');

  const message = await channel.send({ embeds: [embed] });
  await message.react('✅');
  await message.react('❌');

  const filter = (reaction, user) => ['✅', '❌'].includes(reaction.emoji.name) && user.id === userId;
  const collected = await message.awaitReactions({ filter, max: 1, time: 30000, errors: ['time'] });

  const reaction = collected.first();
  if (reaction.emoji.name === '✅') {
    return true;
  } else if (reaction.emoji.name === '❌') {
    return false;
  }
}

// Function to get saved SSH configurations for a user
function getSavedSSHConfigs(userId) {
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

// Function to format saved SSH configurations for display
function formatSavedSSHConfigs(configs) {
  return configs.map((config, index) => {
    return `${index + 1}. Host: ${config.host}, Port: ${config.port}, Username: ${config.username}`;
  }).join('\n');
}

// Function to prompt the user to select a saved SSH configuration
async function selectSSHConfig(configs, channel) {
  const embed = new MessageEmbed()
    .setTitle('Select SSH Configuration')
    .setDescription('Please select a saved SSH configuration by entering its number:')
    .addField('Saved Configurations', formatSavedSSHConfigs(configs), false)
    .setColor('#007fff');

  const message = await channel.send({ embeds: [embed] });

  const filter = (msg) => msg.author.id === channel.recipient.id && !isNaN(msg.content);
  const collected = await channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });

  const selection = collected.first().content;
  const selectedIndex = parseInt(selection) - 1;

  if (selectedIndex >= 0 && selectedIndex < configs.length) {
    return configs[selectedIndex];
  }
}

// Function to prompt the user for SSH inputs
async function promptSSHInputs(channel) {
  const questions = [
    'What is the SSH host?',
    'What is the SSH port?',
    'What is the SSH username?',
    'What is the SSH password?',
  ];

  const answers = [];

  for (const question of questions) {
    const embed = new MessageEmbed()
      .setTitle('SSH Configuration')
      .setDescription(question)
      .setColor('#007fff');

    const message = await channel.send({ embeds: [embed] });

    const filter = (msg) => msg.author.id === channel.recipient.id;
    const collected = await channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });

    const answer = collected.first().content.trim();
    answers.push(answer);
  }

  const [host, portStr, username, password] = answers;

  if (!host || !portStr || !username || !password) {
    return null;
  }

  const port = parseInt(portStr);
  if (isNaN(port)) {
    return null;
  }

  return { host, port, username, password };
}

// Function to ask the user if they want to save the SSH inputs
async function askToSaveInputs(userId, channel) {
  const embed = new MessageEmbed()
    .setTitle('SSH Configuration')
    .setDescription('Do you want to save the SSH inputs for future use?')
    .addField('Options', 'React with ✅ to save the inputs\nReact with ❌ to not save the inputs', false)
    .setColor('#007fff');

  const message = await channel.send({ embeds: [embed] });
  await message.react('✅');
  await message.react('❌');

  const filter = (reaction, user) => ['✅', '❌'].includes(reaction.emoji.name) && user.id === userId;
  const collected = await message.awaitReactions({ filter, max: 1, time: 30000, errors: ['time'] });

  const reaction = collected.first();
  if (reaction.emoji.name === '✅') {
    return true;
  } else if (reaction.emoji.name === '❌') {
    return false;
  }
}

// Function to save the SSH configuration for a user
function saveSSHConfig(userId, sshConfig) {
  return new Promise((resolve, reject) => {
    db.run('INSERT INTO ssh_configs (user_id, host, port, username, password) VALUES (?, ?, ?, ?, ?)',
      [userId, sshConfig.host, sshConfig.port, sshConfig.username, sshConfig.password],
      function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      });
  });
}

// Function to handle Ctrl+C and gracefully terminate the bot
process.on('SIGINT', () => {
  console.log('Terminating SSH bot...');
  db.close();
  process.exit(0);
});

// Login the bot using your bot token
client.login('MTExMDI3MzI5MDY1MzY3NTU1MQ.GPZBH9.Qut3sr1BKdBOyTFvXgrdjSrGQAD5QrquXe29YE');
