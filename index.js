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
        await message.reply('No saved SSH configurations found. Please enter the SSH details manually.');
      } else {
        const selectedConfig = await selectSSHConfig(savedConfigs, dmChannel);
        sshConfig = selectedConfig;
      }
    } else {
      sshConfig = await promptSSHConfig(dmChannel);
    }

    const connectSSH = () => {
      if (!sshConfig.host || !sshConfig.port || !sshConfig.username || !sshConfig.password) {
        const failedEmbed = new MessageEmbed()
          .setTitle('SSH Connection Failed')
          .setDescription('Please provide all the required SSH details.')
          .setColor('#dc3545');

        dmChannel.send({ embeds: [failedEmbed] });
        return;
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
            .setDescription('Enter commands to execute on the remote server. Type "exit" to end the session.')
            .setColor('#007bff');

          dmChannel.send({ embeds: [embed] });
          session.message = dmChannel.lastMessage;

          channel.on('data', (data) => {
            const output = data.toString();
            session.output.push(output);
            if (session.message) {
              session.message.edit(`\`\`\`${session.output.join('')}\`\`\``);
            }
          });

          channel.on('close', () => {
            dmChannel.send('SSH session ended.');
            session.ssh.end();
            activeSessions.delete(message.author.id);
          });

          channel.stderr.on('data', (data) => {
            const error = data.toString();
            session.output.push(error);
            if (session.message) {
              session.message.edit(`\`\`\`${session.output.join('')}\`\`\``);
            }
          });

          // Ask for SSH inputs
          const askForCommand = async () => {
            try {
              const collected = await dmChannel.awaitMessages({ filter: (msg) => msg.author.id === message.author.id, max: 1, time: 60000, errors: ['time'] });
              const userInput = collected.first().content.trim();

              if (userInput.toLowerCase() === 'exit') {
                channel.write('exit\n');
                return;
              }

              channel.write(`${userInput}\n`);
              askForCommand();
            } catch (error) {
              dmChannel.send('No command provided. SSH session ended.');
              channel.write('exit\n');
            }
          };

          askForCommand();
        });
      });

      ssh.on('error', (err) => {
        const failedEmbed = new MessageEmbed()
          .setTitle('SSH Connection Failed')
          .setDescription(`Error connecting to SSH server: ${err.message}`)
          .setColor('#dc3545');

        dmChannel.send({ embeds: [failedEmbed] });
      });

      ssh.connect({
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        password: sshConfig.password,
      });
    };

    connectSSH();
  }
});

async function askToUseSavedInputs(userId, channel) {
  const embed = new MessageEmbed()
    .setTitle('Use Saved SSH Inputs')
    .setDescription('Do you want to use saved SSH configuration inputs?')
    .addField('Yes', 'Type "yes" to use saved inputs')
    .addField('No', 'Type "no" to enter inputs manually')
    .setColor('#007bff');

  await channel.send({ embeds: [embed] });

  const filter = (msg) => msg.author.id === userId && ['yes', 'no'].includes(msg.content.toLowerCase());
  const collected = await channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
  const response = collected.first().content.toLowerCase();

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

async function selectSSHConfig(configs, channel) {
  const embed = new MessageEmbed()
    .setTitle('Select SSH Configuration')
    .setDescription('Choose a saved SSH configuration by typing its corresponding number:')
    .setColor('#007bff');

  configs.forEach((config, index) => {
    embed.addField(`Configuration ${index + 1}`, `Host: ${config.host}\nPort: ${config.port}\nUsername: ${config.username}`);
  });

  await channel.send({ embeds: [embed] });

  const filter = (msg) => msg.author.id === userId && !isNaN(msg.content) && parseInt(msg.content) >= 1 && parseInt(msg.content) <= configs.length;
  const collected = await channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
  const selectedIndex = parseInt(collected.first().content) - 1;

  return configs[selectedIndex];
}

async function promptSSHConfig(channel) {
  const questions = [
    { name: 'host', question: 'Enter the SSH host:', placeholder: 'Host' },
    { name: 'port', question: 'Enter the SSH port:', placeholder: 'Port' },
    { name: 'username', question: 'Enter the SSH username:', placeholder: 'Username' },
    { name: 'password', question: 'Enter the SSH password:', placeholder: 'Password' },
  ];

  const config = {};

  for (const question of questions) {
    const embed = new MessageEmbed()
      .setTitle(question.question)
      .setDescription(`Please enter the ${question.placeholder}:`)
      .setColor('#007bff');

    await channel.send({ embeds: [embed] });

    const filter = (msg) => msg.author.id === userId && msg.content.trim() !== '';
    const collected = await channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
    const userInput = collected.first().content.trim();

    config[question.name] = userInput;
  }

  return config;
}

client.login('MTExMDI3MzI5MDY1MzY3NTU1MQ.GPZBH9.Qut3sr1BKdBOyTFvXgrdjSrGQAD5QrquXe29YE');
