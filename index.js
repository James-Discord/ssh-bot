const { Client, Intents, MessageEmbed, Util } = require('discord.js');
const { Client: SSHClient } = require('ssh2');
const util = require('util');
const { exec } = require('child_process');

const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.DIRECT_MESSAGES, Intents.FLAGS.GUILD_MESSAGES] });
const prefix = '!';

const activeSessions = new Map();
const savedConnections = new Map();

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

    if (savedConnections.has(message.author.id)) {
      const connections = savedConnections.get(message.author.id);
      const savedConnectionsEmbed = new MessageEmbed()
        .setTitle('Saved SSH Connections')
        .setDescription('Please select a connection to connect to:\n\n' + connections.map((conn, index) => `${index + 1}. ${conn.host}`).join('\n'))
        .setColor('#007bff');

      dmChannel.send({ embeds: [savedConnectionsEmbed] });

      collector.on('collect', (m) => {
        const input = m.content.trim();
        const index = parseInt(input, 10);

        if (!isNaN(index) && index > 0 && index <= connections.length) {
          const selectedConnection = connections[index - 1];
          sshConfig = { ...selectedConnection };
          collector.stop();
          connectSSH();
        } else {
          dmChannel.send('Invalid selection. Please enter the number corresponding to the connection you want to connect to.');
        }
      });

      return;
    }

    let sshConfig = {
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
      dmChannel.send(promptMessages[promptCount]);
    };

    sendPrompt();

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

          dmChannel.send('Do you want to save this SSH connection for future use? (yes/no)');

          collector.on('collect', (m) => {
            const saveInput = m.content.trim().toLowerCase();
            if (saveInput === 'yes') {
              if (!savedConnections.has(message.author.id)) {
                savedConnections.set(message.author.id, []);
              }
              savedConnections.get(message.author.id).push(sshConfig);
              dmChannel.send('SSH connection details saved successfully.');
            } else {
              dmChannel.send('SSH connection details not saved.');
            }

            connectSSH();
          });

          break;
      }
    });

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
            return;
          }

          const successEmbed = new MessageEmbed()
            .setTitle('SSH Connection Successful')
            .setDescription('You are now connected via SSH. Type "exit" to end the session.')
            .setColor('#28a745');

          dmChannel.send({ embeds: [successEmbed] });

          session.channel.on('data', (data) => {
            session.output.push(data.toString('utf-8'));
          });

          session.channel.on('close', () => {
            const output = session.output.join('');
            session.ssh.end();
            activeSessions.delete(message.author.id);

            const outputEmbed = new MessageEmbed()
              .setTitle('SSH Session Ended')
              .setDescription('Session output:\n\n' + Util.escapeMarkdown(output))
              .setColor('#ffc107');

            dmChannel.send({ embeds: [outputEmbed] });
          });

          session.message = message;
        });
      });

      ssh.on('error', (err) => {
        const errorEmbed = new MessageEmbed()
          .setTitle('SSH Connection Error')
          .setDescription(`An error occurred while connecting via SSH:\n\n${err.message}`)
          .setColor('#dc3545');

        dmChannel.send({ embeds: [errorEmbed] });
      });

      ssh.connect(sshConfig);
    };
  }
});

client.login('MTExMDI3MzI5MDY1MzY3NTU1MQ.GPZBH9.Qut3sr1BKdBOyTFvXgrdjSrGQAD5QrquXe29YE');
