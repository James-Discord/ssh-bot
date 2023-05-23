const { Client, Intents, MessageEmbed, Util } = require('discord.js');
const { Client: SSHClient } = require('ssh2');
const util = require('util');
const { exec } = require('child_process');
const db = require('quick.db');

const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.DIRECT_MESSAGES, Intents.FLAGS.GUILD_MESSAGES] });
const prefix = '!';

const activeSessions = new Map();

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

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

    if (args[0] === 'save') {
      // Save the SSH connection
      const sshConfig = {
        host: args[1],
        port: parseInt(args[2]),
        username: args[3],
        password: args[4],
      };

      db.push(`sshConnections_${message.author.id}`, sshConfig);
      await message.reply('SSH connection saved successfully.');
      return;
    }

    const savedConnections = db.get(`sshConnections_${message.author.id}`) || [];

    if (savedConnections.length > 0) {
      const savedConnectionsEmbed = new MessageEmbed()
        .setTitle('Saved SSH Connections')
        .setDescription('Please select a connection to connect to:\n\n' + savedConnections.map((conn, index) => `${index + 1}. ${conn.host}`).join('\n'))
        .setColor('#007bff');

      dmChannel.send({ embeds: [savedConnectionsEmbed] });

      collector.on('collect', async (m) => {
        const input = m.content.trim();
        const connectionIndex = parseInt(input) - 1;

        if (!isNaN(connectionIndex) && connectionIndex >= 0 && connectionIndex < savedConnections.length) {
          collector.stop();

          const sshConfig = savedConnections[connectionIndex];
          await connectSSH(sshConfig);
        }
      });
    } else {
      const sshConfig = await promptSSHDetails(dmChannel, collector);

      if (sshConfig) {
        await connectSSH(sshConfig);
      }
    }

    const promptSSHDetails = async (channel, collector) => {
      const sshConfig = {
        host: null,
        port: null,
        username: null,
        password: null,
      };

      const promptMessages = [
        'Enter the SSH host (IP or domain):',
        'Enter the SSH port:',
        'Enter the SSH username:',
        'Enter the SSH password:',
      ];

      let promptCount = 0;

      const sendPrompt = () => {
        channel.send(promptMessages[promptCount++]);
      };

      sendPrompt();

      collector.on('collect', async (m) => {
        const input = m.content.trim();

        if (promptCount === 0) {
          sshConfig.host = input;
          sendPrompt();
        } else if (promptCount === 1) {
          sshConfig.port = parseInt(input);
          sendPrompt();
        } else if (promptCount === 2) {
          sshConfig.username = input;
          sendPrompt();
        } else if (promptCount === 3) {
          sshConfig.password = input;
          collector.stop();

          return sshConfig;
        }
      });
    };

    const connectSSH = async (sshConfig) => {
      const ssh = new SSHClient();

      ssh.on('ready', () => {
        activeSessions.set(message.author.id, ssh);

        const sessionEnded = () => {
          activeSessions.delete(message.author.id);
          ssh.end();
        };

        ssh.on('close', sessionEnded);
        ssh.on('end', sessionEnded);

        ssh.shell((err, stream) => {
          if (err) {
            sessionEnded();
            return;
          }

          const channel = client.channels.cache.get('<YOUR_CHANNEL_ID>'); // Replace with the desired channel ID
          const collector = channel.createMessageCollector({ time: 60000 });

          collector.on('collect', async (m) => {
            if (m.author.id === message.author.id) {
              stream.write(m.content + '\n');
            }
          });

          channel.send('SSH session started. Type `exit` to end the session.');

          stream.on('data', (data) => {
            channel.send('```' + data.toString() + '```');
          });

          stream.on('close', () => {
            collector.stop();
            sessionEnded();
          });
        });
      });

      ssh.on('error', (err) => {
        console.error(err);
        dmChannel.send('An error occurred while connecting to the SSH server.');
      });

      ssh.connect(sshConfig);
    };
  }
});

client.login('MTExMDI3MzI5MDY1MzY3NTU1MQ.GPZBH9.Qut3sr1BKdBOyTFvXgrdjSrGQAD5QrquXe29YE');
