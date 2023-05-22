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
    const collector = dmChannel.createMessageCollector({ filter });

    let sshConfig = {
      host: null,
      port: null,
      username: null,
      password: null,
    };

    let promptCount = 0;

    dmChannel.send('Please provide the SSH details for the connection:');

    collector.on('collect', (m) => {
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

    const timeout = setTimeout(() => {
      collector.stop();
      const failedEmbed = new MessageEmbed()
        .setTitle('SSH Connection Failed')
        .setDescription('SSH connection setup timed out.')
        .setColor('#dc3545');

      dmChannel.send({ embeds: [failedEmbed] });
    }, 10 * 60 * 1000);

    const ssh = new SSHClient();
    ssh.on('ready', () => {
      const session = { ssh, channel: null, message: null };
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
          .setColor('#007bff')
          .setDescription('Use this channel to execute commands.');

        dmChannel.send({ embeds: [embed] }).then((msg) => {
          session.message = msg;
        });

        let outputBuffer = '';

        channel.on('data', (data) => {
          const output = data.toString().trim();
          outputBuffer += output + '\n';
          const embed = new MessageEmbed()
            .setColor('#17c03a')
            .setDescription(`\`\`\`${outputBuffer}\`\`\``);

          session.message.edit({ embeds: [embed] });
        });

        channel.on('close', () => {
          dmChannel.send('SSH session closed.');
          session.ssh.end();
          activeSessions.delete(message.author.id);
        });

        channel.stderr.on('data', (data) => {
          const error = data.toString().trim();
          const embed = new MessageEmbed()
            .setColor('#dc3545')
            .setDescription(`\`\`\`${error}\`\`\``);

          session.message.edit({ embeds: [embed] });
        });
      });
    });

    ssh.on('error', (err) => {
      const embed = new MessageEmbed()
        .setTitle('SSH Connection Error')
        .setDescription(`Failed to connect to "${sshConfig.host}": ${err.message}`)
        .setColor('#dc3545');

      dmChannel.send({ embeds: [embed] });
      activeSessions.delete(message.author.id);
    });

    ssh.connect({
      host: sshConfig.host,
      port: sshConfig.port || 22,
      username: sshConfig.username,
      password: sshConfig.password,
    });

    await dmChannel.send('Enter the SSH host (IP or domain):');
  }
});

client.login('MTExMDI3MzI5MDY1MzY3NTU1MQ.GPZBH9.Qut3sr1BKdBOyTFvXgrdjSrGQAD5QrquXe29YE');
