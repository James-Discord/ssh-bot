const { Client, Intents, MessageEmbed } = require('discord.js');
const { Client: SSHClient } = require('ssh2');
const { exec } = require('child_process');
const { QuickDB } = require("quick.db");

const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.DIRECT_MESSAGES, Intents.FLAGS.GUILD_MESSAGES] });
const prefix = '!';

const db = new QuickDB();

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

    const savedConfigs = db.get(`${message.author.id}.sshConfigs`) || [];
    let sshConfig = {};

    if (savedConfigs.length > 0) {
      const savedEmbed = new MessageEmbed()
        .setTitle('Saved SSH Configurations')
        .setDescription('Choose a saved SSH configuration to connect to:')
        .setColor('#007bff');

      for (let i = 0; i < savedConfigs.length; i++) {
        const { host, port, username } = savedConfigs[i];
        savedEmbed.addField(`${i + 1}. ${host}:${port}`, `Username: ${username}`);
      }

      savedEmbed.addField('0. Enter SSH details manually', 'Connect using manual SSH configuration');

      dmChannel.send({ embeds: [savedEmbed] });

      collector.on('collect', async (m) => {
        const choice = parseInt(m.content.trim());
        if (choice === 0) {
          collector.stop();
          await dmChannel.send('Please enter the SSH details manually:');
          askSSHDetails();
        } else if (choice > 0 && choice <= savedConfigs.length) {
          collector.stop();
          const selectedConfig = savedConfigs[choice - 1];
          connectSSH(selectedConfig);
        }
      });
    } else {
      await dmChannel.send('You have no saved SSH configurations.');
      askSSHDetails();
    }

    const askSSHDetails = () => {
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

      sendPrompt();

      collector.on('collect', async (m) => {
        const input = m.content.trim();

        if (promptCount === 0 && input.toLowerCase() === 'cancel') {
          collector.stop();
          await dmChannel.send('SSH connection canceled.');
          return;
        }

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
            await connectSSH(sshConfig);
            break;
        }
      });
    };

    const connectSSH = async (config) => {
      if (!config.host || !config.port || !config.username || !config.password) {
        await dmChannel.send('Please provide all the required SSH details.');
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
            .setTitle(`SSH session for server "${config.host}"`)
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
                  .setTitle(`SSH session for server "${config.host}"`)
                  .setDescription('```' + updatedOutput + '```')
                  .setColor('#007bff')
                  .setFooter(footerText);

                session.message.edit({ embeds: [updatedEmbed] });

                session.output.splice(0, linesToRemove);
              } else {
                const updatedEmbed = new MessageEmbed()
                  .setTitle(`SSH session for server "${config.host}"`)
                  .setDescription('```' + updatedOutput + '```')
                  .setColor('#007bff');

                session.message.edit({ embeds: [updatedEmbed] });
              }
            });

            channel.on('close', () => {
              const embed = new MessageEmbed()
                .setTitle(`SSH session ended for server "${config.host}"`)
                .setDescription('SSH session closed')
                .setColor('#dc3545');

              session.message.edit({ embeds: [embed] });
              activeSessions.delete(message.author.id);
            });
          });
        });

        // SSH connection successful confirmation
        const embed = new MessageEmbed()
          .setTitle(`SSH connection successful to server "${config.host}"`)
          .setDescription('You can now send commands to the server.')
          .setColor('#28a745');

        dmChannel.send({ embeds: [embed] });
      });

      ssh.on('error', (err) => {
        dmChannel.send(`SSH connection error: ${err.message}`);
      });

      ssh.on('end', () => {
        const embed = new MessageEmbed()
          .setTitle(`SSH session ended for server "${config.host}"`)
          .setDescription('SSH session closed')
          .setColor('#dc3545');

        dmChannel.send({ embeds: [embed] });
        activeSessions.delete(message.author.id);
      });

      try {
        ssh.connect(config);
      } catch (err) {
        dmChannel.send(`Error connecting to SSH: ${err.message}`);
      }
    }
  }
});

client.login('MTExMDI3MzI5MDY1MzY3NTU1MQ.GPZBH9.Qut3sr1BKdBOyTFvXgrdjSrGQAD5QrquXe29YE');
