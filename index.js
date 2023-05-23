const { Client, MessageEmbed, Intents } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const SSHClient = require('ssh2').Client;

// Create a new Discord client with required intents
const client = new Client({ intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.DIRECT_MESSAGES, Intents.FLAGS.GUILD_MESSAGES] });

// Connect to the SQLite database
const db = new sqlite3.Database('./database.db');

// Bot ready event
client.once('ready', () => {
  console.log('SSH Bot is ready!');
});

// Bot message event
client.on('messageCreate', async (message) => {
  if (!message.guild) {
    const dmChannel = await message.author.createDM();
    if (message.content.toLowerCase() === '!ssh') {
      handleSSHCommand(dmChannel);
    }
  }
});

// Handle the "!ssh" command
async function handleSSHCommand(dmChannel) {
  const userId = dmChannel.recipient.id;
  const savedConfigs = await getSavedSSHConfigs(userId);

  if (savedConfigs.length > 0) {
    const config = await selectSSHConfig(savedConfigs, dmChannel);
    if (config) {
      establishSSHConnection(config, userId, dmChannel);
    }
  } else {
    const sshConfig = await enterSSHConfigManually(dmChannel);
    if (sshConfig) {
      saveSSHConfig(sshConfig, userId);
      establishSSHConnection(sshConfig, userId, dmChannel);
    }
  }
}

// Retrieve saved SSH configurations for a user
function getSavedSSHConfigs(userId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM ssh_configs WHERE user_id = ?', userId, (err, rows) => {
      if (err) {
        console.error('Error retrieving saved SSH configurations:', err);
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

// Save an SSH configuration for a user
function saveSSHConfig(sshConfig, userId) {
  db.run(
    'INSERT INTO ssh_configs (user_id, host, port, username, password) VALUES (?, ?, ?, ?, ?)',
    [userId, sshConfig.host, sshConfig.port, sshConfig.username, sshConfig.password],
    (err) => {
      if (err) {
        console.error('Error saving SSH configuration:', err);
      } else {
        console.log('SSH configuration saved successfully!');
      }
    }
  );
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

// Helper function to select an SSH configuration from saved configurations
function selectSSHConfig(savedConfigs, dmChannel) {
  return new Promise(async (resolve) => {
    const embed = new MessageEmbed()
      .setTitle('Saved SSH Configurations')
      .setDescription('Please select the SSH configuration you want to use:')
      .setColor('#0099ff');

    savedConfigs.forEach((config, index) => {
      embed.addField(`Configuration ${index + 1}`, `Host: ${config.host}\nPort: ${config.port}\nUsername: ${config.username}`);
    });

    embed.addField('Cancel', 'Cancel the SSH connection');

    await dmChannel.send({ embeds: [embed] });

    const response = await waitForUserResponse(dmChannel);
    if (!response) {
      resolve(null);
      return;
    }

    const selection = parseInt(response.content.trim());
    if (!isNaN(selection) && selection >= 1 && selection <= savedConfigs.length) {
      resolve(savedConfigs[selection - 1]);
    } else {
      resolve(null);
    }
  });
}

// Helper function to wait for a user response
function waitForUserResponse(dmChannel) {
  return new Promise((resolve) => {
    const collector = dmChannel.createMessageCollector({ filter: (m) => m.author.id === dmChannel.recipient.id, max: 1 });

    collector.on('collect', (message) => {
      resolve(message);
    });

    collector.on('end', (collected, reason) => {
      if (reason === 'time') {
        dmChannel.send('No response received. The operation has been canceled.');
        resolve(null);
      }
    });
  });
}

// Establish an SSH connection using the provided configuration
function establishSSHConnection(sshConfig, userId, dmChannel) {
  const ssh = new SSHClient();

  dmChannel.send('Connecting to SSH...');

  ssh.on('ready', () => {
    dmChannel.send('SSH connection established.');

    dmChannel.send('Enter a command to execute on the SSH server.');

    dmChannel.send('Type "!ssh" to disconnect.');

    dmChannel.awaitMessages({ filter: (m) => m.author.id === dmChannel.recipient.id, max: 1 }).then((collected) => {
      const message = collected.first();

      if (message.content.toLowerCase() === '!ssh') {
        ssh.end();
        return;
      }

      ssh.exec(message.content, (err, stream) => {
        if (err) {
          dmChannel.send(`SSH command execution error: ${err.message}`);
          ssh.end();
          return;
        }

        stream.on('data', (data) => {
          dmChannel.send(data.toString());
        });

        stream.on('close', (code, signal) => {
          if (code === 0) {
            dmChannel.send('SSH command executed successfully.');
          } else {
            dmChannel.send(`SSH command execution failed with code ${code}.`);
          }
          ssh.end();
        });
      });
    });
  });

  ssh.on('error', (err) => {
    dmChannel.send(`SSH connection error: ${err.message}`);
    ssh.end();
  });

  ssh.on('end', async () => {
    await deleteSavedSSHConfigs(userId);
    dmChannel.send('SSH connection terminated.');
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

// Login the bot using your bot token
client.login('MTExMDI3MzI5MDY1MzY3NTU1MQ.GPZBH9.Qut3sr1BKdBOyTFvXgrdjSrGQAD5QrquXe29YE');
