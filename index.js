const { Client, Intents, MessageEmbed } = require('discord.js');
const { Client: SSHClient } = require('ssh2');
const sqlite3 = require('sqlite3').verbose();
const util = require('util');
const { exec } = require('child_process');

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

// Function declarations

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

  const filter = (m) => m.author.id === userId;
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

const getSavedSSHConfigs = (userId) => {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM ssh_configs WHERE user_id = ?', [userId], (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
};

const saveSSHConfig = (userId, config) => {
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
};

const deleteSSHConfig = (userId, configId) => {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM ssh_configs WHERE user_id = ? AND id = ?', [userId, configId], (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
};

const sshConnect = (sshConfig, channel) => {
  const { host, port, username, password } = sshConfig;

  const ssh = new SSHClient();
  ssh.on('ready', () => {
    channel.send('SSH connection established. You can start entering commands.');
    channel.on('messageCreate', async (message) => {
      if (message.author.bot) return;

      const command = message.content.trim();
      if (command.toLowerCase() === 'exit') {
        channel.send('Exiting SSH session...');
        ssh.end();
        channel.removeAllListeners('messageCreate');
        return;
      }

      const executeCommand = util.promisify(ssh.exec).bind(ssh);
      try {
        const { stdout, stderr } = await executeCommand(command);
        if (stdout) {
          channel.send(`\`\`\`${stdout}\`\`\``);
        }
        if (stderr) {
          channel.send(`\`\`\`${stderr}\`\`\``);
        }
      } catch (error) {
        channel.send(`Error executing command: ${error.message}`);
      }
    });
  });

  ssh.on('error', (error) => {
    channel.send(`SSH connection error: ${error.message}`);
  });

  ssh.on('close', (hadError) => {
    if (hadError) {
      channel.send('SSH connection closed with an error.');
    } else {
      channel.send('SSH connection closed.');
    }
  });

  ssh.connect({
    host,
    port,
    username,
    password,
  });
};

// Event handlers

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(' ');
  const command = args.shift().toLowerCase();

  if (command === 'ssh') {
    let sshConfig;
    const dmChannel = await message.author.createDM();

    const useSavedInputs = await askToUseSavedInputs(message.author.id, dmChannel);

    if (useSavedInputs) {
      const savedConfigs = await getSavedSSHConfigs(message.author.id);
      const embed = new MessageEmbed()
        .setTitle('SSH Configurations')
        .setDescription('Select a configuration to use for the SSH session:')
        .addField('Saved Configurations', savedConfigs.map((config, index) => `${index + 1}. ${config.host}`).join('\n'))
        .addField('Enter Selection', 'Type the corresponding number to select the configuration.');

      await dmChannel.send({ embeds: [embed] });

      const filter = (m) => m.author.id === message.author.id;
      const collector = dmChannel.createMessageCollector({ filter, time: 30000 });

      const selectedConfig = await new Promise((resolve) => {
        collector.on('collect', (m) => {
          const input = m.content.trim();
          if (/^\d+$/.test(input)) {
            const index = parseInt(input, 10);
            if (index >= 1 && index <= savedConfigs.length) {
              collector.stop();
              resolve(savedConfigs[index - 1]);
            }
          }
        });

        collector.on('end', () => {
          resolve(null);
        });
      });

      if (!selectedConfig) {
        await dmChannel.send('Invalid selection or selection timed out. Aborting SSH session.');
        return;
      }

      sshConfig = selectedConfig;
    } else {
      const inputEmbed = new MessageEmbed()
        .setTitle('SSH Configuration')
        .setDescription('Please provide the following SSH inputs:')
        .addField('Host', 'Enter the hostname or IP address of the SSH server.')
        .addField('Port', 'Enter the SSH port.')
        .addField('Username', 'Enter the SSH username.')
        .addField('Password', 'Enter the SSH password.');

      await dmChannel.send({ embeds: [inputEmbed] });

      const filter = (m) => m.author.id === message.author.id;
      const collector = dmChannel.createMessageCollector({ filter, max: 4, time: 60000 });

      const inputs = await new Promise((resolve) => {
        const collectedInputs = [];
        collector.on('collect', (m) => {
          const input = m.content.trim();
          collectedInputs.push(input);
        });

        collector.on('end', () => {
          resolve(collectedInputs);
        });
      });

      if (inputs.length !== 4) {
        await dmChannel.send('Insufficient inputs. Aborting SSH session.');
        return;
      }

      const [host, port, username, password] = inputs;
      sshConfig = { host, port, username, password };
    }

    if (sshConfig) {
      sshConnect(sshConfig, dmChannel);
    }
  }
});

client.login('MTExMDI3MzI5MDY1MzY3NTU1MQ.GPZBH9.Qut3sr1BKdBOyTFvXgrdjSrGQAD5QrquXe29YE');
