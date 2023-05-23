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

    const dmChannel = await message.author.createDM();

    const filter = (m) => m.author.id === message.author.id;
    const collector = dmChannel.createMessageCollector({ filter, time: 60000 });

    let sshConfig = {
      host: null,
      port: null,
      username: null,
      password: null,
    };

    async function askSSHDetails() {
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
            connectSSH();
            break;
        }
      });
    }

    async function askUseSavedSSH(dmChannel) {
      const useSavedSSHEmbed = new MessageEmbed()
        .setTitle('Use Saved SSH Details')
        .setDescription('Do you want to use your saved SSH details?\nReply with "yes" or "no".')
        .setColor('#007bff');

      await dmChannel.send({ embeds: [useSavedSSHEmbed] });

      const filter = (m) => m.author.id === dmChannel.recipient.id;
      const collector = dmChannel.createMessageCollector({ filter, time: 60000 });

      return new Promise((resolve) => {
        collector.on('collect', (m) => {
          const input = m.content.trim().toLowerCase();
          if (input === 'yes' || input === 'y') {
            resolve(true);
            collector.stop();
          } else if (input === 'no' || input === 'n') {
            resolve(false);
            collector.stop();
          }
        });
      });
    }

    async function connectSSH() {
      const ssh = new SSHClient();
      const session = {
        ssh,
        channel: null,
      };

      activeSessions.set(message.author.id, session);

      ssh.on('ready', () => {
        session.channel = 'Shell';
        dmChannel.send('SSH connection established. You can now send commands.');
      });

      ssh.on('close', () => {
        activeSessions.delete(message.author.id);
        dmChannel.send('SSH connection closed.');
      });

      ssh.on('error', (error) => {
        activeSessions.delete(message.author.id);
        dmChannel.send(`An error occurred while establishing SSH connection: ${error.message}`);
      });

      ssh.connect(sshConfig);
    }

    if (message.channel.type === 'DM') {
      const useSavedSSH = await askUseSavedSSH(dmChannel);

      if (useSavedSSH) {
        const savedSSHList = db.get('savedSSH') || [];

        if (savedSSHList.length === 0) {
          await dmChannel.send('You have no saved SSH details.');
          askSSHDetails();
          return;
        }

        const embed = createSavedSSHEmbed(savedSSHList);
        await dmChannel.send({ embeds: [embed] });

        const collector = dmChannel.createMessageCollector({ filter, time: 60000 });
        collector.on('collect', async (m) => {
          const input = m.content.trim();
          const selectedOption = parseInt(input, 10);

          if (selectedOption === 0) {
            askSSHDetails();
            collector.stop();
          } else if (selectedOption >= 1 && selectedOption <= savedSSHList.length) {
            const selectedIndex = selectedOption - 1;
            const selectedSSH = savedSSHList[selectedIndex];

            sshConfig = { ...selectedSSH };
            collector.stop();
            connectSSH();
          }
        });
      } else {
        askSSHDetails();
      }
    } else {
      await message.reply('This command can only be used in direct messages with the bot.');
    }
  }
});

function createSavedSSHEmbed(savedSSHList) {
  const embed = new MessageEmbed()
    .setTitle('Saved SSH Details')
    .setDescription('Select the SSH configuration to use by entering its corresponding number:\n');

  savedSSHList.forEach((ssh, index) => {
    const description = `Host: ${ssh.host}\nPort: ${ssh.port}\nUsername: ${ssh.username}`;
    embed.addField(`Configuration ${index + 1}`, description);
  });

  embed.addField('Enter 0', 'Enter new SSH details');
  embed.setColor('#007bff');

  return embed;
}


client.login('MTExMDI3MzI5MDY1MzY3NTU1MQ.GPZBH9.Qut3sr1BKdBOyTFvXgrdjSrGQAD5QrquXe29YE');
