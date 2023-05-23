const { Client, Intents, MessageEmbed, Util } = require('discord.js');
const { Client: SSHClient } = require('ssh2');
const util = require('util');
const { exec } = require('child_process');
const { QuickDB } = require('quick.db');

const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.DIRECT_MESSAGES, Intents.FLAGS.GUILD_MESSAGES] });
const prefix = '!';

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

const activeSessions = new Map();
const db = new QuickDB();

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

    const savedConfigs = db.get(message.author.id) || [];
    const dmChannel = await message.author.createDM();

    const sendPrompt = (promptCount) => {
      dmChannel.send(promptMessages[promptCount]);
    };

    const askSSHDetails = async () => {
      const filter = (m) => m.author.id === message.author.id;
      const collector = dmChannel.createMessageCollector({ filter, time: 60000 });

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

      sendPrompt(promptCount);

      collector.on('collect', (m) => {
        const input = m.content.trim();

        switch (promptCount) {
          case 0:
            sshConfig.host = input;
            promptCount++;
            sendPrompt(promptCount);
            break;
          case 1:
            sshConfig.port = parseInt(input, 10);
            promptCount++;
            sendPrompt(promptCount);
            break;
          case 2:
            sshConfig.username = input;
            promptCount++;
            sendPrompt(promptCount);
            break;
          case 3:
            sshConfig.password = input;
            collector.stop();
            connectSSH(sshConfig);
            break;
        }
      });
    };

    if (savedConfigs.length > 0) {
      const savedConfigsEmbed = new MessageEmbed()
        .setTitle('Saved SSH Configurations')
        .setDescription('Please select the SSH configuration you want to connect to:\n\n' +
          savedConfigs.map((config, index) => `**[${index + 1}]** Host: ${config.host}, Port: ${config.port}`).join('\n') +
          '\n\n**[0]** Enter SSH details manually')
        .setColor('#007bff');

      await dmChannel.send({ embeds: [savedConfigsEmbed] });

      const collector = dmChannel.createMessageCollector({ filter: (m) => m.author.id === message.author.id, time: 60000 });

      collector.on('collect', async (m) => {
        const input = m.content.trim();
        if (input === '0') {
          collector.stop();
          await askSSHDetails();
        } else if (parseInt(input, 10) <= savedConfigs.length) {
          const selectedConfig = savedConfigs[parseInt(input, 10) - 1];
          collector.stop();
          connectSSH(selectedConfig);
        }
      });
    } else {
      await askSSHDetails();
    }

    const connectSSH = (sshConfig) => {
      if (!sshConfig.host || !sshConfig.port || !sshConfig.username || !sshConfig.password) {
        const failedEmbed = new MessageEmbed()
          .setTitle('SSH Connection Failed')
          .setDescription('Please provide all the required SSH details.')
          .setColor('#dc3545');

        dmChannel.send({ embeds: [failedEmbed] });
        return;
      }

      // Save SSH configuration
      const savedConfig = {
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        password: sshConfig.password,
      };
      savedConfigs.push(savedConfig);
      db.set(message.author.id, savedConfigs);

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
            .setColor('#007bff');

          dmChannel.send({ embeds: [embed] }).then((sentMessage) => {
            session.message = sentMessage;

            const collector = dmChannel.createMessageCollector({ filter });
            collector.on('collect', (m) => {
              const content = m.content.trim();
              if (content === '❌') {
                session.ssh.end();
                collector.stop();
              } else {
                channel.write(content + '\n');
              }
            });

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
                  .setColor('#007bff')
                  .setFooter(footerText);

                session.message.edit({ embeds: [updatedEmbed] });

                session.output.splice(0, linesToRemove);
              } else {
                const updatedEmbed = new MessageEmbed()
                  .setTitle(`SSH session for server "${sshConfig.host}"`)
                  .setDescription('```' + updatedOutput + '```')
                  .setColor('#007bff');

                session.message.edit({ embeds: [updatedEmbed] });
              }
            });

            channel.on('close', () => {
              const exitEmbed = new MessageEmbed()
                .setTitle(`SSH session for server "${sshConfig.host}"`)
                .setDescription('SSH session ended.')
                .setColor('#007bff');

              session.message.edit({ embeds: [exitEmbed] });
              activeSessions.delete(message.author.id);
              collector.stop();
            });

            channel.on('error', (err) => {
              const errorEmbed = new MessageEmbed()
                .setTitle(`SSH session for server "${sshConfig.host}"`)
                .setDescription(`An error occurred in the SSH channel: ${err.message}`)
                .setColor('#dc3545');

              session.message.edit({ embeds: [errorEmbed] });
              activeSessions.delete(message.author.id);
              collector.stop();
            });
          });
        });
      });

      ssh.on('error', (err) => {
        const errorEmbed = new MessageEmbed()
          .setTitle('SSH Connection Failed')
          .setDescription(`An error occurred while connecting to the SSH server: ${err.message}`)
          .setColor('#dc3545');

        dmChannel.send({ embeds: [errorEmbed] });
      });

      ssh.connect(sshConfig);
    }
  }
});

client.login('MTExMDI3MzI5MDY1MzY3NTU1MQ.GPZBH9.Qut3sr1BKdBOyTFvXgrdjSrGQAD5QrquXe29YE');
