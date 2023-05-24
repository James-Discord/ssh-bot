const { Client, Intents, MessageEmbed } = require('discord.js');
const { Client: SSHClient } = require('ssh2');
const sqlite3 = require('sqlite3').verbose();
const util = require('util');

const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.DIRECT_MESSAGES, Intents.FLAGS.GUILD_MESSAGES] });
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
        await dmChannel.send('No saved SSH configurations found. Please enter the SSH details manually.');
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
          .setTitle(`SSH session for server ${sshConfig.host}`)
          .setDescription('You are now connected via SSH. Type your commands below.')
          .setColor('#00FF00');
        dmChannel.send({ embeds: [embed] });

        session.message = dmChannel.send('Type `exit` to end the SSH session.');

        session.output = [];
   channel.on('data', (data) => {
   const output = data.toString();
   session.output.push(output.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '')); // Remove escape sequences

  const maxCharacterLength = 3000;
  let updatedOutput = session.output.join('');

  if (updatedOutput.length > maxCharacterLength) {
    const linesToRemove = Math.ceil((updatedOutput.length - maxCharacterLength) / 3000);
    updatedOutput = updatedOutput.slice(-maxCharacterLength);
    const footerText = `The output exceeded the character limit. Removed ${linesToRemove} lines.`;
    const updatedEmbed = new MessageEmbed()
      .setTitle(`SSH session for server "${sshConfig.host}"`)
      .setDescription('```' + updatedOutput + '```')
      .setColor('#00FF00')
      .setFooter(footerText);

    session.message.then((msg) => {
      msg.edit({ embeds: [updatedEmbed] });
    });

    session.output.splice(0, linesToRemove);
  } else {
    const updatedEmbed = new MessageEmbed()
      .setTitle(`SSH session for server "${sshConfig.host}"`)
      .setDescription('```' + updatedOutput + '```')
      .setColor('#00FF00');

    session.message.then((msg) => {
      msg.edit({ embeds: [updatedEmbed] });
    });
  }
});


        const collector = dmChannel.createMessageCollector({ filter: (m) => !m.author.bot });
        collector.on('collect', (m) => {
          const content = m.content.trim();
          if (content.toLowerCase() === 'exit') {
            session.ssh.end();
            collector.stop();
            activeSessions.delete(message.author.id);
          } else {
            channel.write(content + '\n');
          }
        });

        channel.on('close', () => {
          activeSessions.delete(message.author.id);
          dmChannel.send('SSH session ended.');
        });

        channel.on('error', (err) => {
          activeSessions.delete(message.author.id);
          dmChannel.send(`SSH session encountered an error: ${err.message}`);
        });
      });
    });

    ssh.on('error', (err) => {
      dmChannel.send(`SSH connection encountered an error: ${err.message}`);
    });

    ssh.on('end', () => {
      dmChannel.send('SSH connection closed.');
    });

    ssh.connect(sshConfig);
  }
});

async function askToUseSavedInputs(userId, dmChannel) {
  const embed = new MessageEmbed()
    .setTitle('SSH Configuration')
    .setDescription('Do you want to use saved SSH configuration?')
    .setColor('#00FF00')
    .addField('Options', '`yes` - Use saved configuration\n`no` - Enter new configuration');

  dmChannel.send({ embeds: [embed] });

  const filter = (m) => m.author.id === userId;
  const collected = await dmChannel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });

  const response = collected.first().content.trim().toLowerCase();
  return response === 'yes';
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

async function selectSSHConfig(configs, dmChannel) {
  const embed = new MessageEmbed()
    .setTitle('Saved SSH Configurations')
    .setDescription('Select a saved SSH configuration by entering its number:')
    .setColor('#00FF00');

  configs.forEach((config, index) => {
    embed.addField(`Configuration ${index + 1}`, `Host: ${config.host}\nPort: ${config.port}\nUsername: ${config.username}`);
  });

  dmChannel.send({ embeds: [embed] });

  const filter = (m) => m.author.id === dmChannel.recipient.id;
  const collected = await dmChannel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });

  const response = collected.first().content.trim();
  const index = parseInt(response) - 1;
  if (isNaN(index) || index < 0 || index >= configs.length) {
    dmChannel.send('Invalid selection. Please try again.');
    return selectSSHConfig(configs, dmChannel);
  }

  return configs[index];
}
async function promptSSHInputs(dmChannel) {
  const sshConfig = {};

  const prompts = [
    { name: 'host', message: 'Enter the SSH host:', example: 'example.com' },
    { name: 'port', message: 'Enter the SSH port:', example: '22' },
    { name: 'username', message: 'Enter the SSH username:' },
    { name: 'password', message: 'Enter the SSH password:', hidden: true },
  ];

  for (const prompt of prompts) {
    const embed = new MessageEmbed()
      .setTitle('SSH Configuration')
      .setDescription(prompt.message)
      .setColor('#00FF00')
      .addField('Example', `\`${prompt.example || ''}\``);

    dmChannel.send({ embeds: [embed] });

    const filter = (m) => m.author.id === dmChannel.recipient.id;
    const collected = await dmChannel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });

    const response = collected.first().content.trim();
    if (!response) {
      return null;
    }

    sshConfig[prompt.name] = response;
  }

  return sshConfig;
}


async function askToSaveInputs(userId, dmChannel) {
  const embed = new MessageEmbed()
    .setTitle('SSH Configuration')
    .setDescription('Do you want to save these SSH inputs for future use?')
    .setColor('#00FF00')
    .addField('Options', '`yes` - Save inputs\n`no` - Do not save inputs');

  dmChannel.send({ embeds: [embed] });

  const filter = (m) => m.author.id === userId;
  const collected = await dmChannel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });

  const response = collected.first().content.trim().toLowerCase();
  return response === 'yes';
}

async function saveSSHConfig(userId, config) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO ssh_configs (user_id, host, port, username, password) VALUES (?, ?, ?, ?, ?)',
      [userId, config.host, config.port, config.username, config.password],
      (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
}


const token = 'MTExMDI3MzI5MDY1MzY3NTU1MQ.GPZBH9.Qut3sr1BKdBOyTFvXgrdjSrGQAD5QrquXe29YE';
client.login(token);
