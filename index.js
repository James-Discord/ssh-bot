const { Client, Intents, MessageEmbed, Util } = require('discord.js');
const { Client: SSHClient } = require('ssh2');
const util = require('util');
const { exec } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('ssh_configs.db');

const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.DIRECT_MESSAGES, Intents.FLAGS.GUILD_MESSAGES] });
const prefix = '!';

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

const activeSessions = new Map();

const askToUseSavedInputs = async (userId, channel) => {
  const savedConfigs = await getSavedSSHConfigs(userId);
  if (savedConfigs.length === 0) {
    return false;
  }

  const embed = new MessageEmbed()
    .setTitle('SSH Configurations')
    .setDescription('Do you want to use your saved SSH inputs?')
    .addField('Saved Configurations', savedConfigs.map((config, index) => `${index + 1}. ${config.host}`).join('\n'))
    .addField('Enter Selection', 'Type the corresponding number to select the configuration or enter any other character to continue without saving.');

  await channel.send({ embeds: [embed] });

  const filter = (m) => m.author.id === message.author.id;
  const collector = channel.createMessageCollector({ filter, time: 30000 });

  return new Promise((resolve) => {
    collector.on('collect', (m) => {
      const input = m.content.trim();

      if (/^\d+$/.test(input)) {
        const index = parseInt(input, 10);
        if (index >= 1 && index <= savedConfigs.length) {
          collector.stop();
          resolve(true);
        }
      } else {
        collector.stop();
        resolve(false);
      }
    });

    collector.on('end', () => {
      resolve(false);
    });
  });
};

const getSavedSSHConfigs = async (userId) => {
  const allConfigs = await util.promisify(db.all).bind(db)(`SELECT * FROM ssh_configs WHERE user_id = ?`, userId);
  return allConfigs;
};

const selectSSHConfig = async (configs, channel) => {
  const embed = new MessageEmbed()
    .setTitle('Select SSH Configuration')
    .setDescription('Please select one of your saved SSH configurations by typing the corresponding number.')
    .addField('Saved Configurations', configs.map((config, index) => `${index + 1}. ${config.host}`).join('\n'));

  await channel.send({ embeds: [embed] });

  const filter = (m) => m.author.id === message.author.id;
  const collector = channel.createMessageCollector({ filter, time: 30000 });

  return new Promise((resolve) => {
    collector.on('collect', (m) => {
      const input = m.content.trim();

      if (/^\d+$/.test(input)) {
        const index = parseInt(input, 10);
        if (index >= 1 && index <= configs.length) {
          collector.stop();
          resolve(configs[index - 1]);
        }
      }
    });

    collector.on('end', () => {
      resolve(null);
    });
  });
};

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
      const filter = (m) => m.author.id === message.author.id;
      const collector = dmChannel.createMessageCollector({ filter, time: 60000 });

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
            handleSSHConfig(message.author.id, sshConfig);
            connectSSH();
            break;
        }
      });
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
              const embed = new MessageEmbed()
                .setTitle(`SSH session ended for server "${sshConfig.host}"`)
                .setDescription('SSH session closed')
                .setColor('#dc3545');

              session.message.edit({ embeds: [embed] });
              activeSessions.delete(message.author.id);
            });
          });
        });

        // SSH connection successful confirmation
        const embed = new MessageEmbed()
          .setTitle(`SSH session for server "${sshConfig.host}"`)
          .setDescription('SSH connection established successfully!')
          .setColor('#28a745');

        dmChannel.send({ embeds: [embed] });
      });

      ssh.on('error', (err) => {
        const failedEmbed = new MessageEmbed()
          .setTitle('SSH Connection Failed')
          .setDescription(`Error: ${err.message}`)
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

    const handleSSHConfig = (userId, sshConfig) => {
      const insertStatement = db.prepare(`INSERT INTO ssh_configs (user_id, host, port, username, password)
        VALUES (?, ?, ?, ?, ?)`);

      insertStatement.run(userId, sshConfig.host, sshConfig.port, sshConfig.username, sshConfig.password, (err) => {
        if (err) {
          console.error('Error inserting SSH config into database:', err);
        }
      });

      insertStatement.finalize();
    };

    const askToUseSavedInputs = async (userId, channel) => {
      const savedConfigs = await getSavedSSHConfigs(userId);
      if (savedConfigs.length === 0) {
        return false;
      }

      const embed = new MessageEmbed()
        .setTitle('SSH Configurations')
        .setDescription('Do you want to use your saved SSH inputs?')
        .addField('Saved Configurations', savedConfigs.map((config, index) => `${index + 1}. ${config.host}`).join('\n'))
        .addField('Enter Selection', 'Type the corresponding number to select the configuration or enter any other character to continue without saving.');

      await channel.send({ embeds: [embed] });

      const filter = (m) => m.author.id === message.author.id;
      const collector = channel.createMessageCollector({ filter, time: 30000 });

      return new Promise((resolve) => {
        collector.on('collect', (m) => {
          const input = m.content.trim();

          if (/^\d+$/.test(input)) {
            const index = parseInt(input, 10);
            if (index >= 1 && index <= savedConfigs.length) {
              collector.stop();
              resolve(true);
            }
          } else {
            collector.stop();
            resolve(false);
          }
        });

        collector.on('end', () => {
          resolve(false);
        });
      });
    };

    const getSavedSSHConfigs = async (userId) => {
      return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM ssh_configs WHERE user_id = ?`, userId, (err, rows) => {
          if (err) {
            reject(err);
          } else {
            resolve(rows);
          }
        });
      });
    };

    const selectSSHConfig = async (configs, channel) => {
      const embed = new MessageEmbed()
        .setTitle('Select SSH Configuration')
        .setDescription('Please select one of your saved SSH configurations by typing the corresponding number.')
        .addField('Saved Configurations', configs.map((config, index) => `${index + 1}. ${config.host}`).join('\n'));

      await channel.send({ embeds: [embed] });

      const filter = (m) => m.author.id === message.author.id;
      const collector = channel.createMessageCollector({ filter, time: 30000 });

      return new Promise((resolve) => {
        collector.on('collect', (m) => {
          const input = m.content.trim();

          if (/^\d+$/.test(input)) {
            const index = parseInt(input, 10);
            if (index >= 1 && index <= configs.length) {
              collector.stop();
              resolve(configs[index - 1]);
            }
          }
        });

        collector.on('end', () => {
          resolve(null);
        });
      });
    };
  }
});

client.login('MTExMDI3MzI5MDY1MzY3NTU1MQ.GPZBH9.Qut3sr1BKdBOyTFvXgrdjSrGQAD5QrquXe29YE');
