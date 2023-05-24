const { Client, Intents, MessageEmbed } = require('discord.js');
const { Client: SSHClient } = require('ssh2');
const sqlite3 = require('sqlite3').verbose();
const util = require('util');
const os = require('os');

function formatUptime(uptime) {
  const totalSeconds = Math.floor(uptime / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor(((totalSeconds % 86400) % 3600) / 60);
  const seconds = Math.floor(((totalSeconds % 86400) % 3600) % 60);

  return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

// Utility function to format memory usage
function formatMemoryUsage(bytes) {
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 Bytes';
  const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
  if (i === 0) return `${bytes} ${sizes[i]}`;
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}



const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.DIRECT_MESSAGES, Intents.FLAGS.GUILD_MESSAGES] });
const prefix = '!';

// Connect to the SQLite database
const db = new sqlite3.Database('./ssh_configs.db', (err) => {
  if (err) {
    console.error('Failed to connect to the database:', err);
  } else {
    console.log('Connected to the database');
  }
});

// Create the SSH configs table if it doesn't exist
db.run(`CREATE TABLE IF NOT EXISTS ssh_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL
)`);

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
    const start = Date.now();
    const sent = await message.reply('Pinging...');
    const end = Date.now();
    const ping = end - start;
    sent.edit(`Pong! Latency: ${ping}ms, API Latency: ${client.ws.ping}ms`);
  } else if (command === 'hello') {
    await message.reply('Hello, world!');
} else if (command === 'botinfo') {
  const uptime = formatUptime(client.uptime);
  const memoryUsage = formatMemoryUsage(process.memoryUsage().heapUsed);
  const botInfoEmbed = new MessageEmbed()
    .setColor('#00FF00')
    .setTitle('Bot Information')
    .setDescription('Here is some information about the bot:')
    .addFields(
      { name: 'Ping', value: `${client.ws.ping}ms`, inline: true },
      { name: 'Uptime', value: uptime, inline: true },
      { name: 'Memory Usage', value: memoryUsage, inline: true },
      { name: '\u200B', value: '\u200B' }, // Empty field for spacing
      { name: 'Operating System', value: os.platform(), inline: true },
      { name: 'Node.js Version', value: process.version, inline: true },
      { name: 'Discord.js Version', value: require('discord.js').version, inline: true }
    )
    .setTimestamp()
    .setFooter(`Requested by ${message.author.tag}`, message.author.avatarURL());

  await message.reply({ embeds: [botInfoEmbed] });
  
} else if (command === 'ssh-delete') {
  const userId = message.author.id;
  db.all('SELECT * FROM ssh_configs WHERE user_id = ?', [userId], async (err, rows) => {
    if (err) {
      console.error('Failed to fetch SSH configs:', err);
      return;
    }

    if (rows.length === 0) {
      await message.author.send('You have no saved SSH configurations.');
      return;
    }

    const configListEmbed = new MessageEmbed()
      .setColor('#00FF00')
      .setTitle('Saved SSH Configurations')
      .setDescription('Please select the configuration you want to delete:');

    rows.forEach((row, index) => {
      const host = row.host || '-';
      const port = row.port || '-';
      const username = row.username || '-';
      const configDescription = `**Configuration ${index + 1}**\nHost: ${host}\nPort: ${port}\nUsername: ${username}\n`;
      configListEmbed.addField('\u200B', configDescription);
    });

    const dmChannel = await message.author.createDM();
    await dmChannel.send({ embeds: [configListEmbed] });

    const filter = (response) => response.author.id === message.author.id;
    const collector = dmChannel.createMessageCollector({ filter, max: 1, time: 30000 });

    collector.on('collect', async (response) => {
      const input = response.content.trim();
      const configIndex = parseInt(input, 10);

      if (isNaN(configIndex) || configIndex <= 0 || configIndex > rows.length) {
        await dmChannel.send('Invalid input. Please enter a valid number from the list.');
        return;
      }

      const selectedConfig = rows[configIndex - 1];

      const confirmationEmbed = new MessageEmbed()
        .setColor('#FFA500')
        .setTitle('Confirmation')
        .setDescription(`Are you sure you want to delete the following SSH configuration?\nHost: ${selectedConfig.host || '-'}\nPort: ${selectedConfig.port || '-'}\nUsername: ${selectedConfig.username || '-'}\nPassword: ${selectedConfig.password || '-'}`)
        .setFooter('Please type "confirm" to proceed.');

      await dmChannel.send({ embeds: [confirmationEmbed] });

      const confirmationCollector = dmChannel.createMessageCollector({ filter, max: 1, time: 30000 });

      confirmationCollector.on('collect', async (response) => {
        const confirmation = response.content.trim().toLowerCase();

        if (confirmation === 'confirm') {
          db.run('DELETE FROM ssh_configs WHERE id = ?', [selectedConfig.id], (deleteErr) => {
            if (deleteErr) {
              console.error('Failed to delete SSH config:', deleteErr);
              return;
            }
            dmChannel.send('SSH configuration deleted successfully.');
          });
        } else {
          dmChannel.send('Deletion cancelled.');
        }
      });

      confirmationCollector.on('end', (collected) => {
        if (collected.size === 0) {
          dmChannel.send('No confirmation received. Aborting deletion.');
        }
      });
    });

    collector.on('end', (collected) => {
      if (collected.size === 0) {
        dmChannel.send('No input received. Aborting deletion.');
      }
    });
  });

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
        await dmChannel.send('No saved SSH configurations found. Please enter the SSH details manually and rerun the command!');
      } else {
        const selectedConfig = await selectSSHConfig(savedConfigs, dmChannel);
        sshConfig = selectedConfig;
      }
    } else {
      sshConfig = await promptSSHInputs(dmChannel);
      if (!sshConfig) {
        await message.reply('Invalid or incomplete SSH inputs. Please try again.');
        return;
      }

      const saveInputs = await askToSaveInputs(message.author.id, dmChannel);
      if (saveInputs) {
        await saveSSHConfig(message.author.id, sshConfig);
        await message.reply('SSH inputs saved successfully!');
      }
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
          .setTitle(`SSH session for server ${sshConfig.host}`)
          .setDescription('You are now connected via SSH. Type your commands below.')
          .setColor('#00FF00');
        dmChannel.send({ embeds: [embed] });

        session.message = dmChannel.send('Type `exit` to end the SSH session.');

        session.output = [];
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
      .setColor('#00FF00')
      .setFooter(footerText);

    session.message.then((msg) => {
      msg.edit({ embeds: [updatedEmbed] });
    });

    session.output.splice(0, linesToRemove);
  } else {
    const updatedEmbed = new MessageEmbed()
      .setTitle(`SSH session for server "${sshConfig.host}"`)
      .setDescription('```' + updatedOutput + '```')
      .setColor('#00FF00');

    session.message.then((msg) => {
      msg.edit({ embeds: [updatedEmbed] });
    });
  }
});


        const collector = dmChannel.createMessageCollector({ filter: (m) => !m.author.bot });
        collector.on('collect', (m) => {
          const content = m.content.trim();
          if (content.toLowerCase() === 'exit') {
            session.ssh.end();
            collector.stop();
            activeSessions.delete(message.author.id);
          } else {
            channel.write(content + '\n');
          }
        });

        channel.on('close', () => {
          activeSessions.delete(message.author.id);
          dmChannel.send('SSH session ended.');
        });

        channel.on('error', (err) => {
          activeSessions.delete(message.author.id);
          dmChannel.send(`SSH session encountered an error: ${err.message}`);
        });
      });
    });

    ssh.on('error', (err) => {
      dmChannel.send(`SSH connection encountered an error: ${err.message}`);
    });

    ssh.on('end', () => {
      dmChannel.send('SSH connection closed.');
    });

    ssh.connect(sshConfig);
  }
});

async function askToUseSavedInputs(userId, dmChannel) {
  const embed = new MessageEmbed()
    .setTitle('SSH Configuration')
    .setDescription('Do you want to use saved SSH configuration?')
    .setColor('#00FF00')
    .addField('Options', '`yes` - Use saved configuration\n`no` - Enter new configuration');

  dmChannel.send({ embeds: [embed] });

  const filter = (m) => m.author.id === userId;
  const collected = await dmChannel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });

  const response = collected.first().content.trim().toLowerCase();
  return response === 'yes';
}

async function getSavedSSHConfigs(userId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM ssh_configs WHERE user_id = ?', [userId], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

async function selectSSHConfig(configs, dmChannel) {
  const embed = new MessageEmbed()
    .setTitle('Saved SSH Configurations')
    .setDescription('Select a saved SSH configuration by entering its number:')
    .setColor('#00FF00');

  configs.forEach((config, index) => {
    embed.addField(`Configuration ${index + 1}`, `Host: ${config.host}\nPort: ${config.port}\nUsername: ${config.username}`);
  });

  dmChannel.send({ embeds: [embed] });

  const filter = (m) => m.author.id === dmChannel.recipient.id;
  const collected = await dmChannel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });

  const response = collected.first().content.trim();
  const index = parseInt(response) - 1;
  if (isNaN(index) || index < 0 || index >= configs.length) {
    dmChannel.send('Invalid selection. Please try again.');
    return selectSSHConfig(configs, dmChannel);
  }

  return configs[index];
}
async function promptSSHInputs(dmChannel) {
  const sshConfig = {};

const prompts = [
  { name: 'host', message: 'Enter the SSH host:', example: 'example.com' },
  { name: 'port', message: 'Enter the SSH port:', example: '22' },
  { name: 'username', message: 'Enter the SSH username:' },
  { name: 'password', message: 'Enter the SSH password:', hidden: true },
];

async function getSSHConfig() {
  const sshConfig = {};

  for (const prompt of prompts) {
    const embed = new MessageEmbed()
      .setTitle('SSH Configuration')
      .setDescription(prompt.message)
      .setColor('#00FF00')
      .addField('Example', `\`${prompt.example || ''}\``);

    dmChannel.send({ embeds: [embed] });

    const filter = (m) => m.author.id === dmChannel.recipient.id;
    const collected = await dmChannel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });

    const response = collected.first().content.trim();
    if (!response) {
      return null;
    }

    if (prompt.name === 'port' && !/^\d+$/.test(response)) {
      dmChannel.send('Invalid port input. Please enter a valid port number and run the code again.');
      return null;
    }

    sshConfig[prompt.name] = response;
  }

  return sshConfig;
}


async function askToSaveInputs(userId, dmChannel) {
  const embed = new MessageEmbed()
    .setTitle('SSH Configuration')
    .setDescription('Do you want to save these SSH inputs for future use?')
    .setColor('#00FF00')
    .addField('Options', '`yes` - Save inputs\n`no` - Do not save inputs');

  dmChannel.send({ embeds: [embed] });

  const filter = (m) => m.author.id === userId;
  const collected = await dmChannel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });

  const response = collected.first().content.trim().toLowerCase();
  return response === 'yes';
}

async function saveSSHConfig(userId, config) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO ssh_configs (user_id, host, port, username, password) VALUES (?, ?, ?, ?, ?)',
      [userId, config.host, config.port, config.username, config.password],
      (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
}


const token = 'MTExMDI3MzI5MDY1MzY3NTU1MQ.GPZBH9.Qut3sr1BKdBOyTFvXgrdjSrGQAD5QrquXe29YE';
client.login(token);
