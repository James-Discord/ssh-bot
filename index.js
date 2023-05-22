const { Client, Intents, MessageEmbed } = require('discord.js');
const { Client: SSHClient } = require('ssh2');

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
    const collector = dmChannel.createMessageCollector({ filter, time: 600000 });

    let sshConfig = {
      host: null,
      port: null,
      username: null,
      password: null,
    };

    let promptCount = 0;

    dmChannel.send('Please provide the SSH details for the connection:');

    const timeout = setTimeout(() => {
      collector.stop('TIMEOUT');
    }, 600000); // 10 minutes timeout

    collector.on('collect', (m) => {
      clearTimeout(timeout);

      const input = m.content.trim();

      switch (promptCount) {
        case 0:
          sshConfig.host = input;
          promptCount++;
          dmChannel.send('Enter the SSH port:');
          break;
        case 1:
          sshConfig.port = parseInt(input, 10);
          promptCount++;
          dmChannel.send('Enter the SSH username:');
          break;
        case 2:
          sshConfig.username = input;
          promptCount++;
          dmChannel.send('Enter the SSH password:');
          break;
        case 3:
          sshConfig.password = input;
          collector.stop();
          break;
      }
    });

    collector.on('end', async (collected, reason) => {
      if (reason === 'TIMEOUT') {
        const failedEmbed = new MessageEmbed()
          .setTitle('SSH Connection Failed')
          .setDescription('Timeout: No response received within 10 minutes.')
          .setColor('#dc3545');

        dmChannel.send({ embeds: [failedEmbed] });
        return;
      }

      const ssh = new SSHClient();
      ssh.on('ready', () => {
        const session = { ssh, channel: null, message: null, commandList: [] };
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
                session.commandList.push(content);
              }
            });

            channel.on('data', (data) => {
              const output = data.toString();
              const updatedEmbed = new MessageEmbed()
                .setTitle(`SSH session for server "${sshConfig.host}"`)
                .setDescription(`\`\`\`bash\n${session.commandList.join('\n')}\n\n${output}\`\`\``)
                .setColor('#007bff');

              session.message.edit({ embeds: [updatedEmbed] });
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
      }).on('error', (err) => {
        const failedEmbed = new MessageEmbed()
          .setTitle('SSH Connection Failed')
          .setDescription(`Error establishing SSH connection: ${err.message}`)
          .setColor('#dc3545');

        dmChannel.send({ embeds: [failedEmbed] });
        ssh.end();
      }).on('end', () => {
        const embed = new MessageEmbed()
          .setTitle('SSH Connection Closed')
          .setDescription('SSH connection closed.')
          .setColor('#dc3545');

        dmChannel.send({ embeds: [embed] });
      });

      ssh.connect(sshConfig); // Connect SSH after all prompts are collected
    });

    await dmChannel.send('Enter the SSH host (IP or domain):');
  }
});

client.login('MTExMDI3MzI5MDY1MzY3NTU1MQ.GPZBH9.Qut3sr1BKdBOyTFvXgrdjSrGQAD5QrquXe29YE');
