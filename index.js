const Discord = require('discord.js');
const { Client, MessageEmbed } = require('discord.js');
const { Client: SSHClient } = require('ssh2');
const sqlite3 = require('sqlite3').verbose();

const client = new Client();
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

client.on('messageCreate', async (message) => {
  if (!message.guild) return;
  if (message.author.bot) return;
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === 'ssh') {
    const dmChannel = await message.author.createDM();

    // Check if there are saved SSH configurations for the user
    const savedConfigs = await getSavedSSHConfigs(message.author.id);
    if (savedConfigs.length === 0) {
      await message.reply('No saved SSH configurations found. Please enter the SSH details manually.');

      const sshConfig = await enterSSHConfigManually(dmChannel);
      if (!sshConfig) {
        await message.reply('SSH configuration input cancelled.');
        return;
      }

      await saveSSHConfig(message.author.id, sshConfig);
      await message.reply('SSH configuration saved successfully!');
    } else {
      // Prompt the user to select a saved SSH configuration
      const selectedConfig = await selectSSHConfig(savedConfigs, dmChannel);
      if (!selectedConfig) {
        await message.reply('SSH configuration selection cancelled.');
        return;
      }

      await message.reply(`Selected SSH configuration: ${selectedConfig.host}`);
    }

    // Connect to SSH using the selected or manually entered configuration
    establishSSHConnection(selectedConfig || sshConfig, message.author.id, message.channel);
  }
});

client.login('MTExMDI3MzI5MDY1MzY3NTU1MQ.GPZBH9.Qut3sr1BKdBOyTFvXgrdjSrGQAD5QrquXe29YE');

// Helper function to get saved SSH configurations from the database
function getSavedSSHConfigs(userId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM ssh_configs WHERE user_id = ?', userId, (err, rows) => {
      if (err) {
        console.error('Error fetching saved SSH configurations:', err);
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

// Helper function to save an SSH configuration to the database
function saveSSHConfig(userId, sshConfig) {
  return new Promise((resolve, reject) => {
    const insertStatement = db.prepare(
      'INSERT INTO ssh_configs (user_id, host, port, username, password) VALUES (?, ?, ?, ?, ?)'
    );

    insertStatement.run(
      userId,
      sshConfig.host,
      sshConfig.port,
      sshConfig.username,
      sshConfig.password,
      (err) => {
        if (err) {
          console.error('Error inserting SSH config into database:', err);
          reject(err);
        } else {
          resolve();
        }
      }
    );

    insertStatement.finalize();
  });
}

// Helper function to prompt the user to enter the SSH configuration manually
function enterSSHConfigManually(dmChannel) {
  return new Promise(async (resolve) => {
    const sshConfig = {};

    const questions = [
      'Enter the SSH host:',
      'Enter the SSH port:',
      'Enter the SSH username:',
      'Enter the SSH password:'
    ];

    for (let i = 0; i < questions.length; i++) {
      await dmChannel.send(questions[i]);

      const response = await waitForUserResponse(dmChannel);
      if (!response) {
        resolve(null);
        return;
      }

      switch (i) {
        case 0:
          sshConfig.host = response.content.trim();
          break;
        case 1:
          sshConfig.port = parseInt(response.content.trim());
          break;
        case 2:
          sshConfig.username = response.content.trim();
          break;
        case 3:
          sshConfig.password = response.content.trim();
          break;
      }
    }

    resolve(sshConfig);
  });
}

// Helper function to select an SSH configuration from a list
function selectSSHConfig(configs, dmChannel) {
  return new Promise(async (resolve) => {
    const embed = new MessageEmbed()
      .setTitle('Select SSH Configuration')
      .setDescription('Please select the SSH configuration to use:');

    configs.forEach((config, index) => {
      embed.addField(`${index + 1}. ${config.host}`, `Port: ${config.port}\nUsername: ${config.username}`);
    });

    await dmChannel.send(embed);
    await dmChannel.send('Enter the number corresponding to your selection (or "cancel" to cancel):');

    const response = await waitForUserResponse(dmChannel);
    if (!response) {
      resolve(null);
      return;
    }

    const selection = parseInt(response.content.trim());
    if (isNaN(selection) || selection < 1 || selection > configs.length) {
      await dmChannel.send('Invalid selection. SSH configuration selection cancelled.');
      resolve(null);
    } else {
      resolve(configs[selection - 1]);
    }
  });
}

// Helper function to wait for a user response in a DM channel
function waitForUserResponse(dmChannel) {
  return new Promise((resolve) => {
    const filter = (m) => m.author.id === dmChannel.recipient.id;
    const collector = dmChannel.createMessageCollector({ filter, max: 1, time: 60000 });

    collector.on('collect', (message) => {
      resolve(message);
    });

    collector.on('end', (collected) => {
      if (collected.size === 0) {
        resolve(null);
      }
    });
  });
}

// Helper function to establish an SSH connection
function establishSSHConnection(sshConfig, userId, channel) {
  const ssh = new SSHClient();
  ssh.on('ready', () => {
    channel.send('SSH connection established! You can now execute commands.');

    ssh.shell((err, stream) => {
      if (err) {
        channel.send(`Error opening SSH shell: ${err.message}`);
        ssh.end();
        return;
      }

      channel.on('messageCreate', async (message) => {
        if (!message.guild) return;
        if (message.author.bot) return;

        // Send user input to SSH shell
        stream.write(`${message.content}\n`);

        // Capture SSH shell output
        let output = '';
        stream.on('data', (data) => {
          output += data.toString();
        });

        // Process SSH shell output
        stream.on('close', async (code, signal) => {
          const response = `SSH command executed with exit code ${code}\n\n${output}`;
          await message.reply(response);
          channel.send('Enter another command or type "!ssh" to disconnect.');

          // Disconnect SSH on "!ssh" command
          if (message.content.toLowerCase() === '!ssh') {
            ssh.end();
          }
        });
      });
    });
  });

  ssh.on('error', (err) => {
    channel.send(`SSH connection error: ${err.message}`);
    ssh.end();
  });

  ssh.on('end', async () => {
    await deleteSavedSSHConfigs(userId);
    channel.send('SSH connection terminated.');
  });

  ssh.connect({
    host: sshConfig.host,
    port: sshConfig.port,
    username: sshConfig.username,
    password: sshConfig.password
  });
}

// Helper function to delete saved SSH configurations for a user
function deleteSavedSSHConfigs(userId) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM ssh_configs WHERE user_id = ?', userId, (err) => {
      if (err) {
        console.error('Error deleting saved SSH configurations:', err);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}
