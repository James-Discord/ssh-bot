const { Client, Intents, MessageEmbed } = require('discord.js');
const { Client: SSHClient } = require('ssh2');

const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.DIRECT_MESSAGES, Intents.FLAGS.GUILD_MESSAGES] });
const prefix = '!';

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
    const existingSession = message.author.sshSession;

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

    let promptCount = 0;

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

    collector.on('end', async (collected) => {
      const ssh = new SSHClient();
      ssh.on('ready', () => {
        const session = { ssh, channel: null };
        message.author.sshSession = session; // Store session information on the user object

        session.channel = ssh.shell((err, channel) => {
          if (err) {
            dmChannel.send(`Error starting SSH shell: ${err.message}`);
            session.ssh.end();
            delete message.author.sshSession; // Remove session information from the user object
            return;
          }

          const collector = dmChannel.createMessageCollector({ filter, time: 600000 });
          collector.on('collect', (m) => {
            const content = m.content.trim();
            if (content === '❌') {
              session.ssh.end();
              collector.stop();
            } else {
              session.channel.write(content + '\n');
            }
          });

          channel.on('data', (data) => {
            const output = data.toString();
            dmChannel.send(`\`\`\`${output}\`\`\``);
          });

          channel.on('close', () => {
            const embed = new MessageEmbed()
              .setTitle(`SSH session ended for server "${sshConfig.host}"`)
              .setDescription('SSH session closed.');
            dmChannel.send(embed);
            delete message.author.sshSession; // Remove session information from the user object
          });
        });

        // SSH connection successful confirmation
        dmChannel.send('SSH connection established successfully!');
      }).on('error', (err) => {
        message.reply(`SSH connection error: ${err.message}`);
        ssh.end();
      }).on('end', () => {
        message.reply('SSH connection closed.');
      }).connect(sshConfig);
    });

    await dmChannel.send('Please provide the SSH details for the connection:');
    await dmChannel.send('Enter the SSH host (IP or domain):');
  }
});

client.login('MTExMDI3MzI5MDY1MzY3NTU1MQ.GPZBH9.Qut3sr1BKdBOyTFvXgrdjSrGQAD5QrquXe29YE');
