const { Client, Intents, MessageEmbed } = require('discord.js');
const { Client: SSHClient } = require('ssh2');
const util = require('util');
const { exec } = require('child_process');
const QuickDB = require('quick.db');
const db = new QuickDB();

const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.DIRECT_MESSAGES, Intents.FLAGS.GUILD_MESSAGES] });
const prefix = '!';

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

    const filter = (m) => m.author.id === message.author.id;
    const collector = dmChannel.createMessageCollector({ filter, time: 60000 });

    let sshConfig = {
      host: null,
      port: null,
      username: null,
      password: null,
    };

    const storedSSHConfig = db.get(`ssh_${message.author.id}`);

    if (storedSSHConfig && args[0] !== '0') {
      const storedConfigEmbed = new MessageEmbed()
        .setTitle('Stored SSH Login Details')
        .setDescription(`Host: ${storedSSHConfig.host}\nPort: ${storedSSHConfig.port}\nUsername: ${storedSSHConfig.username}`)
        .setColor('#007bff');

      const savePromptEmbed = new MessageEmbed()
        .setTitle('SSH Login Details')
        .setDescription('Do you want to use the stored SSH login details? Reply with `yes` or `no`.')
        .setColor('#ffc107');

      dmChannel.send({ embeds: [storedConfigEmbed, savePromptEmbed] });

      collector.once('collect', (m) => {
        const input = m.content.toLowerCase();

        if (input === 'yes') {
          sshConfig = storedSSHConfig;
          connectSSH();
        } else if (input === 'no') {
          sendPrompt();
        } else {
          collector.stop();
        }
      });
    } else {
      sendPrompt();
    }

    let promptCount = 0;

    const promptMessages = [
      'Enter the SSH host (IP or domain):',
      'Enter the SSH port:',
      'Enter the SSH username:',
      'Enter the SSH password:',
    ];

    const sendPrompt = () => {
      dmChannel.send(promptMessages[promptCount]);
    };

    collector.on('collect', (m) => {
      const input = m.content.trim();

      switch (promptCount) {
        case 0:
          sshConfig.host = input;
          promptCount++;
          sendPrompt();
          break;
        case 1:
          sshConfig.port = parseInt(input, 10);
          promptCount++;
          sendPrompt();
          break;
        case 2:
          sshConfig.username = input;
          promptCount++;
          sendPrompt();
          break;
        case 3:
          sshConfig.password = input;
          collector.stop();
          saveSSHConfig();
          connectSSH();
          break;
      }
    });

    const saveSSHConfig = () => {
      const savePromptEmbed = new MessageEmbed()
        .setTitle('Save SSH Login Details')
        .setDescription('Do you want to save these SSH login details for future use? Reply with `yes` or `no`.')
        .setColor('#ffc107');

      dmChannel.send({ embeds: [savePromptEmbed] });

      collector.once('collect', (m) => {
        const input = m.content.toLowerCase();

        if (input === 'yes') {
          db.set(`ssh_${message.author.id}`, sshConfig);
        }
      });
    };

    const connectSSH = () => {
      if (!sshConfig.host || !sshConfig.port || !sshConfig.username || !sshConfig.password) {
        const failedEmbed = new MessageEmbed()
          .setTitle('SSH Connection')
          .setDescription('Incomplete SSH login details. Please provide all required information.')
          .setColor('#dc3545');

        dmChannel.send({ embeds: [failedEmbed] });
        return;
      }

      const ssh = new SSHClient();
      activeSessions.set(message.author.id, ssh);

      ssh.on('ready', () => {
        const successEmbed = new MessageEmbed()
          .setTitle('SSH Connection')
          .setDescription('Successfully connected to SSH server.')
          .setColor('#28a745');

        dmChannel.send({ embeds: [successEmbed] });
      });

      ssh.on('close', () => {
        activeSessions.delete(message.author.id);

        const closeEmbed = new MessageEmbed()
          .setTitle('SSH Connection')
          .setDescription('SSH session closed.')
          .setColor('#6c757d');

        dmChannel.send({ embeds: [closeEmbed] });
      });

      ssh.on('error', (err) => {
        activeSessions.delete(message.author.id);

        const errorEmbed = new MessageEmbed()
          .setTitle('SSH Connection')
          .setDescription(`An error occurred during SSH connection: ${err.message}`)
          .setColor('#dc3545');

        dmChannel.send({ embeds: [errorEmbed] });
      });

      ssh.connect({
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        password: sshConfig.password,
      });
    }
  }
});


client.login('MTExMDI3MzI5MDY1MzY3NTU1MQ.GPZBH9.Qut3sr1BKdBOyTFvXgrdjSrGQAD5QrquXe29YE');
