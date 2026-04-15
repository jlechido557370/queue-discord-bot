require("dotenv").config();
const fs = require("fs");
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

// DATA LOADING
let playerStats = {};
let matchCounter = 1;
let matchHistory = {};
let deckStats = {};

// Track deck usage and registrations
try {
  const rawData = JSON.parse(fs.readFileSync("elo.json"));
  if (rawData.stats) {
    playerStats = rawData.stats;
    matchCounter = rawData.counter || 1;
    matchHistory = rawData.history || {};
    deckStats = rawData.decks || {}; // Load deck stats
  } else {
    playerStats = rawData;
    matchCounter = 1;
  }
} catch {
  playerStats = {};
  matchCounter = 1;
  matchHistory = {};
  deckStats = {};
}

// BACKWARD COMPATIBILITY & SELF-HEALING DECK STATS
// This looks at all your past matches and recalculates deck wins/losses
// so your current data gets exact winrates immediately.
Object.keys(deckStats).forEach((deck) => {
  deckStats[deck].wins = 0;
  deckStats[deck].losses = 0;
  deckStats[deck].usage = 0;
});

Object.values(matchHistory).forEach((match) => {
  const wDeck = match.winnerDeck;
  const lDeck = match.loserDeck;

  if (wDeck) {
    if (!deckStats[wDeck]) deckStats[wDeck] = { usage: 0, wins: 0, losses: 0 };
    deckStats[wDeck].usage++;
    deckStats[wDeck].wins++;
  }
  if (lDeck) {
    if (!deckStats[lDeck]) deckStats[lDeck] = { usage: 0, wins: 0, losses: 0 };
    deckStats[lDeck].usage++;
    deckStats[lDeck].losses++;
  }
});

function saveData() {
  const dataToSave = {
    stats: playerStats,
    counter: matchCounter,
    history: matchHistory,
    decks: deckStats, // Save deck stats
  };

  // FIX: Swapped to asynchronous saving to prevent bot freezes
  fs.promises
    .writeFile("elo.json", JSON.stringify(dataToSave, null, 2))
    .catch((err) => console.error("Failed to save data asynchronously:", err));
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// CHANNEL & ROLE IDS
const QUEUE_CHANNEL_ID = "Insert Discord ID";
const RANKED_CHANNEL_ID = "Insert Discord ID";
const LOG_CHANNEL_ID = "Insert Discord ID";
const BOT_COMMANDS_CHANNEL_ID = "Insert Discord ID";
const ANNOUNCEMENT_CHANNEL_ID = "Insert Discord ID";
const RESET_CHANNEL_ID = "Insert Discord ID";
const ADMIN_ROLE_ID = "Insert Discord ID";
const DECK_SUBMIT_CHANNEL_ID = "Insert Discord ID"; // PUT YOUR NEW CHANNEL ID HERE

// RANK ROLE IDS
const RANK_ROLES = {
  "Disintegrating Stud": "YOUR_ROLE_ID",
  "Broken Stud I": "YOUR_ROLE_ID",
  "Broken Stud II": "YOUR_ROLE_ID",
  "Broken Stud III": "YOUR_ROLE_ID",
  "Cosmic Stud I": "YOUR_ROLE_ID",
  "Cosmic Stud II": "YOUR_ROLE_ID",
  "Cosmic Stud III": "YOUR_ROLE_ID",
  "Circle Stud I": "YOUR_ROLE_ID",
  "Circle Stud II": "YOUR_ROLE_ID",
  "Circle Stud III": "YOUR_ROLE_ID",
  "Stud I": "YOUR_ROLE_ID",
  "Stud II": "YOUR_ROLE_ID",
  "Stud III": "YOUR_ROLE_ID",
  "Nascent Stud": "YOUR_ROLE_ID",
};

// Queue + Matches
let queue = [];
let pendingQueue = new Set();
// Track players waiting the 10s delay
let matches = {};

client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  setInterval(checkQueue, 10000);
});

// --- HELPER FUNCTIONS ---
function isPlayerInMatch(userId) {
  return Object.values(matches).some((match) => match.players.includes(userId));
}

function getDisplayElo(id) {
  const p = getPlayer(id);
  return p.placed ? `**${p.elo}**` : "`[PLACING]`";
}

function getDisplayRank(id) {
  const p = getPlayer(id);
  if (!p.placed) return `Nascent Stud ${p.placements}/8`;
  return getRank(p.elo);
}

function formatPlayer(id) {
  return `<@${id}> — ${getDisplayElo(id)} (${getDisplayRank(id)})`;
}

function createBaseEmbed() {
  return new EmbedBuilder().setColor(0x32cd32);
}

// FUZZY DECK MATCHER
function findBestDeckMatch(input) {
  const registeredDecks = Object.keys(deckStats);
  if (registeredDecks.length === 0) return input;

  const inputWords = input.toLowerCase().split(/\s+/);
  let bestMatch = input; // Default to what they typed if no match is found
  let highestScore = 0;

  for (const deck of registeredDecks) {
    const deckLower = deck.toLowerCase();
    // Check if EVERY typed abbreviation word is found somewhere in the official deck name
    const allWordsMatch = inputWords.every((word) => deckLower.includes(word));

    if (allWordsMatch) {
      // Score based on how close the lengths are to prioritize accurate matches
      const score = 100 - Math.abs(deck.length - input.length);
      if (score > highestScore) {
        highestScore = score;
        bestMatch = deck;
      }
    }
  }
  return bestMatch;
}

// PAGINATION GENERATORS
function generateTopEmbed(page = 1) {
  const sorted = Object.entries(playerStats)
    .filter(([_, data]) => data.placed)
    .sort((a, b) => b[1].elo - a[1].elo)
    .slice(0, 150); // Cap at top 150

  const totalPages = Math.max(1, Math.ceil(sorted.length / 10));
  const currentPage = Math.min(Math.max(1, page), totalPages);

  const startIndex = (currentPage - 1) * 10;
  const slice = sorted.slice(startIndex, startIndex + 10);

  let leaderboardStr = slice
    .map(
      ([id, data], i) =>
        `**${startIndex + i + 1}.** <@${id}> — ${getDisplayElo(id)} (${getDisplayRank(id)})`,
    )
    .join("\n");

  const placedCount = sorted.length;
  const totalMatches = Object.keys(matchHistory).length;
  const avgElo =
    placedCount > 0
      ? Math.round(
          sorted.reduce((sum, [, data]) => sum + (data.elo || 0), 0) /
            placedCount,
        )
      : 0;

  const embed = createBaseEmbed()
    .setTitle(`Top Players Leaderboard (Page ${currentPage}/${totalPages})`)
    .setDescription(
      leaderboardStr || "*No players have finished placements yet.*",
    )
    .setFooter({
      text: `${placedCount} players — ${totalMatches} matches — ${avgElo} elo avg • ${new Date().toLocaleString()}`,
    });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`toppage_${currentPage - 1}`)
      .setLabel("⬅️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage <= 1),
    new ButtonBuilder()
      .setCustomId(`toppage_${currentPage + 1}`)
      .setLabel("➡️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages),
  );

  return { embeds: [embed], components: [row] };
}

function generateDeckTopEmbed(page = 1) {
  const sorted = Object.entries(deckStats)
    .filter(([_, data]) => (data?.usage || 0) > 0)
    .sort((a, b) => b[1].usage - a[1].usage)
    .slice(0, 150); // Cap at top 150

  const totalPages = Math.max(1, Math.ceil(sorted.length / 10));
  const currentPage = Math.min(Math.max(1, page), totalPages);

  const startIndex = (currentPage - 1) * 10;
  const slice = sorted.slice(startIndex, startIndex + 10);

  let deckStr = slice
    .map(([name, data], i) => {
      // Calculate Winrate
      const wins = data.wins || 0;
      const winrate =
        data.usage > 0 ? Math.round((wins / data.usage) * 100) : 0;
      return `**${startIndex + i + 1}.** ${name} — \`${data.usage} matches\` - winrate ${winrate}%`;
    })
    .join("\n");

  const embed = createBaseEmbed()
    .setTitle(`Most Played Decks (Page ${currentPage}/${totalPages})`)
    .setDescription(deckStr || "*No decks registered or played yet.*");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`decktoppage_${currentPage - 1}`)
      .setLabel("⬅️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage <= 1),
    new ButtonBuilder()
      .setCustomId(`decktoppage_${currentPage + 1}`)
      .setLabel("➡️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages),
  );

  return { embeds: [embed], components: [row] };
}

function generateDeckWinEmbed(page = 1) {
  const sorted = Object.entries(deckStats)
    // Only show decks with at least 5 matches played
    .filter(([_, data]) => (data?.usage || 0) >= 5)
    .sort((a, b) => {
      const winrateA =
        a[1].usage > 0 ? Math.round(((a[1].wins || 0) / a[1].usage) * 100) : 0;
      const winrateB =
        b[1].usage > 0 ? Math.round(((b[1].wins || 0) / b[1].usage) * 100) : 0;

      // Tiebreaker: if winrates are identical, sort by number of matches played
      if (winrateB !== winrateA) return winrateB - winrateA;
      return b[1].usage - a[1].usage;
    })
    .slice(0, 150); // Cap at top 150

  const totalPages = Math.max(1, Math.ceil(sorted.length / 10));
  const currentPage = Math.min(Math.max(1, page), totalPages);

  const startIndex = (currentPage - 1) * 10;
  const slice = sorted.slice(startIndex, startIndex + 10);

  let deckStr = slice
    .map(([name, data], i) => {
      // Calculate Winrate
      const wins = data.wins || 0;
      const winrate =
        data.usage > 0 ? Math.round((wins / data.usage) * 100) : 0;
      return `**${startIndex + i + 1}.** ${name} — \`${winrate}% winrate\` - ${data.usage} matches`;
    })
    .join("\n");

  const embed = createBaseEmbed()
    .setTitle(`Highest Winrate Decks (Page ${currentPage}/${totalPages})`)
    .setDescription(
      deckStr || "*No decks have played at least 5 matches yet.*",
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`deckwinpage_${currentPage - 1}`)
      .setLabel("⬅️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage <= 1),
    new ButtonBuilder()
      .setCustomId(`deckwinpage_${currentPage + 1}`)
      .setLabel("➡️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages),
  );

  return { embeds: [embed], components: [row] };
}

function generateRankEmbed(userId, userObj, page = 1) {
  const targetPlayer = getPlayer(userId);

  const sortedPlaced = Object.entries(playerStats)
    .filter(([_, data]) => data.placed)
    .sort((a, b) => b[1].elo - a[1].elo);

  const placementIndex = sortedPlaced.findIndex(([id]) => id === userId);
  const placementTxt =
    placementIndex !== -1 ? `#${placementIndex + 1}` : "Unranked";

  const userHistoryIds = Object.keys(matchHistory)
    .filter(
      (id) =>
        matchHistory[id].winner === userId || matchHistory[id].loser === userId,
    )
    .reverse();

  const totalPages = Math.max(1, Math.ceil(userHistoryIds.length / 5));
  const currentPage = Math.min(Math.max(1, page), totalPages);

  const startIndex = (currentPage - 1) * 5;
  const historySlice = userHistoryIds.slice(startIndex, startIndex + 5);

  let historyStr = historySlice
    .map((id) => {
      const h = matchHistory[id];
      const isWin = h.winner === userId;
      return `\`Match #${id}\` — ${isWin ? "🟩 **WIN**" : "🟥 **LOSS**"}`;
    })
    .join("\n");

  if (!historyStr) historyStr = "*No matches played yet.*";

  const recentDecks =
    targetPlayer.recentDecks && targetPlayer.recentDecks.length > 0
      ? targetPlayer.recentDecks
          .slice(0, 5)
          .map((d, i) => `${i + 1}. ${d}`)
          .join("\n")
      : "*No recent decks.*";

  const firstMatchId = userHistoryIds.length
    ? [...userHistoryIds].sort((a, b) => Number(a) - Number(b))[0]
    : null;

  const firstMatchFooter = firstMatchId
    ? `First match: #${firstMatchId} • ${new Date(matchHistory[firstMatchId].timestamp).toLocaleString()}`
    : "First match: No matches played yet.";

  const totalGames = targetPlayer.wins + targetPlayer.losses;
  const winrate =
    totalGames > 0 ? Math.round((targetPlayer.wins / totalGames) * 100) : 0;

  const autoAcceptStatus = targetPlayer.autoAccept ? "✅ ON" : "❌ OFF";

  // Dynamic Elo display for the profile to show peak elo
  const profileEloDisplay = targetPlayer.placed
    ? `${targetPlayer.elo} (Peak: ${targetPlayer.peakElo || targetPlayer.elo})`
    : "[PLACING]";

  const embed = createBaseEmbed()
    .setTitle(`Player Profile: ${userObj.username}`)
    .setThumbnail(userObj.displayAvatarURL())
    .setDescription(
      `────────────────────────────────────────\n` +
        `**Leaderboard Rank:** ${placementTxt}\n` +
        `**Current Rank:** ${getDisplayRank(userId)}\n` +
        `**Elo:** ${profileEloDisplay}\n\n` +
        `**Wins:** ${targetPlayer.wins} | **Losses:** ${targetPlayer.losses} | **Winrate:** ${winrate}%\n` +
        `**Current Winstreak:** ${targetPlayer.winstreak || 0} (Best: ${targetPlayer.highestWinstreak || 0})\n` +
        `**Auto-Accept:** ${autoAcceptStatus}\n\n` +
        `**Recent Decks Used:**\n${recentDecks}\n\n` +
        `**Match History (Page ${currentPage}/${totalPages}):**\n${historyStr}`,
    )
    .setFooter({ text: firstMatchFooter });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`rankpage_${userId}_${currentPage - 1}`)
      .setLabel("⬅️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage <= 1),
    new ButtonBuilder()
      .setCustomId(`rankpage_${userId}_${currentPage + 1}`)
      .setLabel("➡️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages),
  );

  return { embeds: [embed], components: [row] };
}

// QUEUE CHECKER
async function checkQueue() {
  if (queue.length < 2) return;

  queue.sort((a, b) => getPlayer(a.id).elo - getPlayer(b.id).elo);

  let p1Index = -1;
  let p2Index = -1;
  let forceMatch = false;

  for (let i = 0; i < queue.length; i++) {
    if (Date.now() - queue[i].joinedAt > 120000) {
      forceMatch = true;
      p1Index = i;
      if (i > 0 && i < queue.length - 1) {
        const diffBelow = Math.abs(
          getPlayer(queue[i].id).elo - getPlayer(queue[i - 1].id).elo,
        );
        const diffAbove = Math.abs(
          getPlayer(queue[i].id).elo - getPlayer(queue[i + 1].id).elo,
        );
        p2Index = diffBelow < diffAbove ? i - 1 : i + 1;
      } else if (i > 0) {
        p2Index = i - 1;
      } else {
        p2Index = i + 1;
      }
      break;
    }
  }

  if (!forceMatch) {
    for (let i = 0; i < queue.length - 1; i++) {
      if (
        Math.abs(getPlayer(queue[i].id).elo - getPlayer(queue[i + 1].id).elo) <=
        200
      ) {
        p1Index = i;
        p2Index = i + 1;
        break;
      }
    }
  }

  if (p1Index !== -1 && p2Index !== -1) {
    const p1 = queue[p1Index];
    const p2 = queue[p2Index];

    queue.splice(Math.max(p1Index, p2Index), 1);
    queue.splice(Math.min(p1Index, p2Index), 1);

    const matchId = matchCounter++;
    saveData();

    const rankedChannel = await client.channels.fetch(RANKED_CHANNEL_ID);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`accept_${matchId}`)
        .setLabel("Accept Match")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`cancel_${matchId}`)
        .setLabel("Decline")
        .setStyle(ButtonStyle.Danger),
    );

    const matchEmbed = createBaseEmbed()
      .setTitle(
        forceMatch
          ? `⚠️ FORCED MATCH FOUND (#${matchId})`
          : `MATCH FOUND (#${matchId})`,
      )
      .setThumbnail(client.user.displayAvatarURL())
      .setDescription(
        `────────────────────────────────────────\n\n` +
          `${formatPlayer(p1.id)}\n**VS**\n${formatPlayer(p2.id)}\n\n*You have 60 seconds to accept!*`,
      );

    const matchMessage = await rankedChannel.send({
      content: `<@${p1.id}> <@${p2.id}>`,
      embeds: [matchEmbed],
      components: [row],
    });

    matches[matchId] = {
      players: [p1.id, p2.id],
      decks: { [p1.id]: p1.deck, [p2.id]: p2.deck },
      accepted: [],
      message: matchMessage,
      timeout: setTimeout(async () => {
        const m = matches[matchId];
        if (!m) return;
        m.players
          .filter((p) => !m.accepted.includes(p))
          .forEach((d) => {
            let pd = getPlayer(d);
            pd.elo = Math.max(0, pd.elo - 15);
          });
        saveData();
        if (m.message)
          await m.message.edit({
            content:
              "**Match cancelled** (Timeout). Unready players lost 15 Elo.",
            embeds: [],
            components: [],
          });
        delete matches[matchId];
      }, 60000),
    };

    // Handle auto-accept logic instantly for this match
    const m = matches[matchId];
    const p1Stats = getPlayer(p1.id);
    const p2Stats = getPlayer(p2.id);

    if (p1Stats.autoAccept) m.accepted.push(p1.id);
    if (p2Stats.autoAccept) m.accepted.push(p2.id);

    if (m.accepted.length === 2) {
      clearTimeout(m.timeout);
      const readyEmbed = createBaseEmbed()
        .setTitle(`Match ${matchId} Ready!`)
        .setThumbnail(client.user.displayAvatarURL())
        .setDescription(
          `────────────────────────────────────────\n\n` +
            `${formatPlayer(m.players[0])}\n**VS**\n${formatPlayer(m.players[1])}\n\n**Report winner:**\n\`!win ${matchId} @winner\``,
        );

      // Instantly edit the message since both auto-accepted
      await matchMessage.edit({
        content: `<@${p1.id}> <@${p2.id}>`,
        embeds: [readyEmbed],
        components: [],
      });
    }
  }
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // COMMAND: !autoaccept
  if (message.content === "!autoaccept") {
    if (message.channel.id !== BOT_COMMANDS_CHANNEL_ID)
      return message.reply(`Please use this in <#${BOT_COMMANDS_CHANNEL_ID}>.`);

    const player = getPlayer(message.author.id);
    player.autoAccept = !player.autoAccept; // Toggle the state
    saveData();

    const status = player.autoAccept ? "✅ **ON**" : "❌ **OFF**";
    return message.reply(`Your Queue Auto-Accept is now ${status}.`);
  }

  // COMMAND: !send (deck name)
  if (message.content.startsWith("!send ")) {
    if (message.channel.id !== DECK_SUBMIT_CHANNEL_ID) return;

    // Restrict @everyone, @here, and direct user/role mentions
    if (
      /@everyone|@here|<@!?\d+>|<@&\d+>/.test(message.content) ||
      message.mentions.users.size > 0 ||
      message.mentions.roles.size > 0 ||
      message.mentions.everyone
    ) {
      return message.reply(
        "Please do not mention users or roles in the deck name.",
      );
    }

    const rawDeckName = message.content.replace("!send ", "").trim();

    if (!rawDeckName)
      return message.reply(
        "Please provide a deck name! (e.g., `!send Rainbow Terrarian Gladiator`)",
      );

    // Restrict special characters (allowing slashes)
    if (!/^[a-zA-Z0-9 \/]+$/.test(rawDeckName)) {
      return message.reply(
        "⚠️ Deck names can only contain letters, numbers, and slashes (/).",
      );
    }

    // FIX: Character limit check for deck registration
    if (rawDeckName.length > 30) {
      return message.reply(
        "⚠️ That deck name is too long! Please keep it under 30 characters.",
      );
    }

    // Fix formatting (Title Case for cleanliness)
    const deckName = rawDeckName.replace(
      /\w\S*/g,
      (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase(),
    );

    if (!deckStats[deckName]) {
      deckStats[deckName] = { usage: 0, wins: 0, losses: 0 };
      saveData();
      return message.reply(
        `✅ Successfully registered new deck: **${deckName}**! You can now use abbreviations to queue with it.`,
      );
    } else {
      return message.reply(`⚠️ **${deckName}** is already registered!`);
    }
  }

  // COMMAND: !decktop (Most played decks)
  if (message.content === "!decktop" || message.content === "!deckstops") {
    if (message.channel.id !== BOT_COMMANDS_CHANNEL_ID)
      return message.reply(`Please use this in <#${BOT_COMMANDS_CHANNEL_ID}>.`);
    const deckData = generateDeckTopEmbed(1);
    return message.channel.send(deckData);
  }

  // COMMAND: !deckwin (Highest winrate decks)
  if (message.content === "!deckwin" || message.content === "!deckwins") {
    if (message.channel.id !== BOT_COMMANDS_CHANNEL_ID)
      return message.reply(`Please use this in <#${BOT_COMMANDS_CHANNEL_ID}>.`);
    const deckData = generateDeckWinEmbed(1);
    return message.channel.send(deckData);
  }

  // Setup
  if (message.content === "!setup") {
    if (message.channel.id !== QUEUE_CHANNEL_ID) return;
    const setupEmbed = createBaseEmbed()
      .setTitle("Ranked Queue")
      .setThumbnail(client.user.displayAvatarURL({ size: 128 }))
      .setImage(
        "https://images-ext-1.discordapp.net/external/QVpBTy4CHHn4rBJBTmBvOnfAtSIe3awjrKWdQO0_5lA/https/media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExc2lpNWw0eDBleThrZXEzbzVpZzd0cDZxZDU0aTIycXE3dXZ3cWwydSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/kJ33bcehBuMxKZO7LJ/giphy.gif",
      )
      .setDescription(
        `──────────────────────────────────────\n\n` +
          "Click the buttons below to manage your queue status. Good luck!",
      )
      .setFooter({ text: "JUST YOUR DECK NAME NOT YOUR FULL DECK CODE" });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("join_queue_prompt")
        .setLabel("Join Queue (Select Deck)")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("leave_queue")
        .setLabel("Leave Queue")
        .setStyle(ButtonStyle.Danger),
    );
    return message.channel.send({ embeds: [setupEmbed], components: [row] });
  }

  // Help Command
  if (message.content === "!help") {
    const helpEmbed = createBaseEmbed()
      .setTitle("BCMT Ranked Rules & Commands")
      .setDescription(
        `**Player Commands (<#${BOT_COMMANDS_CHANNEL_ID}>)**\n` +
          `• \`!rank\` → View your stats\n` +
          `• \`!top\` → Top players leaderboard\n` +
          `• \`!decktop\` → Most played decks\n` +
          `• \`!deckwin\` → Highest winrate decks\n` +
          `• \`!match [ID]\` → Match history + Elo change\n` +
          `• \`!autoaccept\` → Toggle auto-accepting queues\n\n` +
          `**Queue Rules**\n` +
          `• **Join Queue:** Use the buttons in <#${QUEUE_CHANNEL_ID}>\n` +
          `• **Match Range:** ±200 Elo only\n` +
          `• **Accept Timer:** 60 seconds to accept match\n` +
          `• **Dodge Penalty:** -15 Elo if you decline or don’t accept\n` +
          `• Matches must be played in **Blox Cards TCG (Roblox)**\n\n` +
          `**Reporting Matches**\n` +
          `• Report Wins in <#${RANKED_CHANNEL_ID}> using:\n` +
          `\`!win [MatchID] @winner\``,
      );

    return message.channel.send({ embeds: [helpEmbed] });
  }

  // UPDATED: Top Players with Pages
  if (message.content === "!top") {
    const topData = generateTopEmbed(1);
    return message.channel.send(topData);
  }

  // Reset
  if (message.content === "!reset") {
    if (message.channel.id !== RESET_CHANNEL_ID)
      return message.reply(`Use this in <#${RESET_CHANNEL_ID}>.`);
    if (!message.member.roles.cache.has(ADMIN_ROLE_ID))
      return message.reply(
        "You don't have the required admin role to do this!",
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_reset_${message.author.id}`)
        .setLabel("CONFIRM RESET")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`cancel_reset_${message.author.id}`)
        .setLabel("Decline")
        .setStyle(ButtonStyle.Secondary),
    );

    const embed = createBaseEmbed()
      .setTitle("⚠️ WARNING: RESET DATABASE")
      .setDescription(
        `This will wipe **ALL DATA** and create an automatic backup:\n\n- Elo\n- Ranks\n- Match History\n- Queue\n\nClick **CONFIRM RESET** to proceed.`,
      );
    return message.channel.send({ embeds: [embed], components: [row] });
  }

  // Win
  if (message.content.startsWith("!win")) {
    const args = message.content.split(" ");
    const matchId = args[1];
    const winnerUser = message.mentions.users.first();
    const match = matches[matchId];

    if (!match) return message.reply("Invalid match ID.");
    if (message.channel.id !== RANKED_CHANNEL_ID)
      return message.reply("Use this in the ranked channel only.");
    if (!match.players.includes(message.author.id))
      return message.reply("You are not part of this match.");
    if (!winnerUser || !match.players.includes(winnerUser.id))
      return message.reply("Invalid winner.");

    // Immediately lock the match down to prevent race conditions
    // from two players typing the command at the exact same time
    delete matches[matchId];

    const winnerId = winnerUser.id;
    const loserId = match.players.find((id) => id !== winnerId);

    const wPlayer = getPlayer(winnerId);
    const lPlayer = getPlayer(loserId);

    // Increment Deck Usages & Winrates
    const wDeck = match.decks[winnerId];
    const lDeck = match.decks[loserId];

    if (wDeck) {
      if (!deckStats[wDeck])
        deckStats[wDeck] = { usage: 0, wins: 0, losses: 0 };
      deckStats[wDeck].usage++;
      if (deckStats[wDeck].wins === undefined) deckStats[wDeck].wins = 0;
      deckStats[wDeck].wins++;
    }

    if (lDeck) {
      if (!deckStats[lDeck])
        deckStats[lDeck] = { usage: 0, wins: 0, losses: 0 };
      deckStats[lDeck].usage++;
      if (deckStats[lDeck].losses === undefined) deckStats[lDeck].losses = 0;
      deckStats[lDeck].losses++;
    }

    if (!wPlayer.recentDecks) wPlayer.recentDecks = [];
    if (!lPlayer.recentDecks) lPlayer.recentDecks = [];

    if (wDeck && !wPlayer.recentDecks.includes(wDeck)) {
      wPlayer.recentDecks.unshift(wDeck);
      if (wPlayer.recentDecks.length > 5) wPlayer.recentDecks.pop();
    }

    if (lDeck && !lPlayer.recentDecks.includes(lDeck)) {
      lPlayer.recentDecks.unshift(lDeck);
      if (lPlayer.recentDecks.length > 5) lPlayer.recentDecks.pop();
    }

    const winnerOld = { ...getPlayer(winnerId) };
    const loserOld = { ...getPlayer(loserId) };
    const winnerOldRank = getRank(winnerOld.elo);
    const result = updateElo(winnerId, loserId);

    const winnerNew = getPlayer(winnerId);
    const loserNew = getPlayer(loserId);

    const winOldTxt = winnerOld.placed
      ? `${winnerOld.elo} ${getRank(winnerOld.elo)}`
      : `Placing`;
    const winNewTxt = winnerNew.placed
      ? `${winnerNew.elo} ${getRank(winnerNew.elo)}`
      : `Placing ${winnerNew.placements}/8`;
    const loseOldTxt = loserOld.placed
      ? `${loserOld.elo} ${getRank(loserOld.elo)}`
      : `Placing`;
    const loseNewTxt = loserNew.placed
      ? `${loserNew.elo} ${getRank(loserNew.elo)}`
      : `Placing ${loserNew.placements}/8`;

    const winDeckTxt = wDeck ? `[Deck: ${wDeck}]` : "";
    const loseDeckTxt = lDeck ? `[Deck: ${lDeck}]` : "";

    const winnerStatsLine = `🟢 Winner: <@${winnerId}> ${winDeckTxt}\n~~${winOldTxt}~~ ➔ ${winNewTxt} (+${result.winnerGain} Elo)`;
    const loserStatsLine = `🔴 Loser: <@${loserId}> ${loseDeckTxt}\n~~${loseOldTxt}~~ ➔ ${loseNewTxt} (-${result.loserLoss} Elo)`;

    const winEmbed = createBaseEmbed()
      .setTitle(`Match #${matchId} Results`)
      .setThumbnail(winnerUser.displayAvatarURL())
      .setDescription(
        `────────────────────────────────────────\n\n` +
          `${winnerStatsLine}\n\n${loserStatsLine}\n\n` +
          `Played on ${new Date().toLocaleString()}`,
      );

    matchHistory[matchId] = {
      winner: winnerId,
      loser: loserId,
      winnerGain: result.winnerGain,
      loserLoss: result.loserLoss,
      winOldTxt: winOldTxt,
      winNewTxt: winNewTxt,
      loseOldTxt: loseOldTxt,
      loseNewTxt: loseNewTxt,
      winnerDeck: wDeck || null,
      loserDeck: lDeck || null,
      timestamp: Date.now(),
    };

    saveData();

    const logChannel = await client.channels
      .fetch(LOG_CHANNEL_ID)
      .catch(() => null);
    if (logChannel) logChannel.send({ embeds: [winEmbed] });

    message.reply(
      `Match #${matchId} recorded! Results sent to <#${LOG_CHANNEL_ID}>.`,
    );

    const guild = message.guild;
    const winnerMember = await guild.members.fetch(winnerId).catch(() => null);
    const loserMember = await guild.members.fetch(loserId).catch(() => null);

    if (winnerMember && winnerNew.placed)
      await updateRole(winnerMember, winnerNew.elo);
    if (loserMember && loserNew.placed)
      await updateRole(loserMember, loserNew.elo);

    if (winnerNew.placed && winnerOldRank !== getRank(winnerNew.elo)) {
      const announceChannel = await client.channels
        .fetch(ANNOUNCEMENT_CHANNEL_ID)
        .catch(() => null);
      if (announceChannel) {
        const promoEmbed = createBaseEmbed()
          .setTitle("🎉 Promotion!")
          .setThumbnail(winnerUser.displayAvatarURL())
          .setDescription(
            `────────────────────────────────────────\n\n` +
              `**CONGRATULATIONS!** <@${winnerId}> has been promoted to **${getRank(winnerNew.elo)}**!`,
          );
        announceChannel.send({ embeds: [promoEmbed] });
      }
    }
  }

  // Rank command
  if (message.content.startsWith("!rank")) {
    const args = message.content.split(" ").slice(1);
    let targetUser = message.mentions.users.first();

    if (!targetUser && args.length > 0) {
      const searchTerm = args.join(" ").toLowerCase();
      try {
        const members = await message.guild.members.fetch({
          query: searchTerm,
          limit: 1,
        });
        const member = members.first();
        if (member) {
          targetUser = member.user;
        } else {
          return message.reply(
            `Could not find a user matching "${searchTerm}".`,
          );
        }
      } catch (e) {
        console.error("Failed to fetch user:", e);
        return message.reply(
          "An error occurred while trying to find that user.",
        );
      }
    }

    if (!targetUser) targetUser = message.author; // Default to self

    const rankData = generateRankEmbed(targetUser.id, targetUser, 1);
    return message.channel.send(rankData);
  }

  // Match History Inspect
  if (message.content.startsWith("!match ")) {
    if (message.channel.id !== BOT_COMMANDS_CHANNEL_ID)
      return message.reply(`Please use this in <#${BOT_COMMANDS_CHANNEL_ID}>.`);

    const args = message.content.split(" ");
    const matchId = args[1];
    const history = matchHistory[matchId];

    if (!history) return message.reply(`Match #${matchId} not found.`);

    const g =
      history.winnerGain !== undefined ? `+${history.winnerGain}` : "???";
    const l = history.loserLoss !== undefined ? `-${history.loserLoss}` : "???";

    const winDeckTxt = history.winnerDeck
      ? ` [Deck: ${history.winnerDeck}]`
      : "";
    const loseDeckTxt = history.loserDeck
      ? ` [Deck: ${history.loserDeck}]`
      : "";

    const historyEmbed = createBaseEmbed()
      .setTitle(`Match #${matchId} History`)
      .setDescription(
        `────────────────────────────────────────\n\n` +
          `🟢 Winner: <@${history.winner}>${winDeckTxt}\n~~${history.winOldTxt || "?"}~~ ➔ ${history.winNewTxt || "?"} (${g} Elo)\n\n` +
          `🔴 Loser: <@${history.loser}>${loseDeckTxt}\n~~${history.loseOldTxt || "?"}~~ ➔ ${history.loseNewTxt || "?"} (${l} Elo)\n\n\n` +
          `Played on ${new Date(history.timestamp).toLocaleString()}`,
      );
    return message.channel.send({ embeds: [historyEmbed] });
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton() && interaction.customId === "join_queue_prompt") {
    // Checks if they are in the official queue OR the pending 10s wait queue
    if (
      queue.some((q) => q.id === interaction.user.id) ||
      pendingQueue.has(interaction.user.id)
    )
      return interaction.reply({
        content: "Already in queue.",
        ephemeral: true,
      });

    if (isPlayerInMatch(interaction.user.id))
      return interaction.reply({
        content: "Finish your match first!",
        ephemeral: true,
      });

    const modal = new ModalBuilder()
      .setCustomId("deck_modal")
      .setTitle("Queue Setup");

    const deckInput = new TextInputBuilder()
      .setCustomId("deck_input")
      .setLabel("What deck are you using?")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(20) // FIX: Cap modal input to 20 characters
      .setPlaceholder("e.g. rainb terra glad");

    modal.addComponents(new ActionRowBuilder().addComponents(deckInput));

    await interaction.showModal(modal);
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === "deck_modal") {
    const rawDeckInput = interaction.fields.getTextInputValue("deck_input");

    // Restrict special characters (allowing slashes)
    if (!/^[a-zA-Z0-9 \/]+$/.test(rawDeckInput)) {
      return interaction.reply({
        content:
          "⚠️ Deck names can only contain letters, numbers, and slashes (/).",
        ephemeral: true,
      });
    }

    // Run the fuzzy matcher
    let deckName = findBestDeckMatch(rawDeckInput);

    // Auto-register deck if it's not registered
    if (!deckStats[deckName]) {
      deckName = deckName.replace(
        /\w\S*/g,
        (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase(),
      );

      if (!deckStats[deckName]) {
        deckStats[deckName] = { usage: 0, wins: 0, losses: 0 };
        saveData();
      }
    }

    const userId = interaction.user.id;
    // 10 second delay system starts here
    pendingQueue.add(userId);

    const serverEmbed = new EmbedBuilder()
      .setColor(0x32cd32)
      .setTitle("Joining Queue...")
      .setDescription(
        `You will be added to the queue with **${deckName}** in 10 seconds.\nIf you made a mistake, click **Leave Queue** to cancel and try again.\n\nAre you already in the official Ranked Private Server?\nIf not, click the button below to join it now so you are ready when a match is found!`,
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("Join Private Server")
        .setStyle(ButtonStyle.Link)
        .setURL(
          "https://www.roblox.com/share?code=0f00fbc891d92f41a5d81751812bb4ad&type=Server",
        ),
    );

    await interaction.reply({
      embeds: [serverEmbed],
      components: [row],
      ephemeral: true,
    });

    setTimeout(() => {
      // Check if they didn't leave the queue manually during the 10 seconds
      if (pendingQueue.has(userId)) {
        pendingQueue.delete(userId);
        queue.push({ id: userId, deck: deckName, joinedAt: Date.now() });
        checkQueue();
      }
    }, 10000);
    return;
  }

  if (!interaction.isButton()) return;
  const userId = interaction.user.id;

  // Handle Player Top Pagination
  if (interaction.customId.startsWith("toppage_")) {
    const newPage = parseInt(interaction.customId.split("_")[1]);
    const newData = generateTopEmbed(newPage);
    return interaction.update(newData);
  }

  // Handle Deck Top Pagination
  if (interaction.customId.startsWith("decktoppage_")) {
    const newPage = parseInt(interaction.customId.split("_")[1]);
    const newData = generateDeckTopEmbed(newPage);
    return interaction.update(newData);
  }

  // Handle Deck Win Pagination
  if (interaction.customId.startsWith("deckwinpage_")) {
    const newPage = parseInt(interaction.customId.split("_")[1]);
    const newData = generateDeckWinEmbed(newPage);
    return interaction.update(newData);
  }

  if (interaction.customId.startsWith("rankpage_")) {
    const parts = interaction.customId.split("_");
    const targetId = parts[1];
    const newPage = parseInt(parts[2]);

    const targetUser = await client.users.fetch(targetId).catch(() => null);
    if (!targetUser)
      return interaction.reply({ content: "User not found.", ephemeral: true });
    const newData = generateRankEmbed(targetId, targetUser, newPage);
    return interaction.update(newData);
  }

  if (interaction.customId.startsWith("confirm_reset_")) {
    const targetUserId = interaction.customId.split("_")[2];
    if (interaction.user.id !== targetUserId)
      return interaction.reply({
        content: "You are not allowed to confirm this reset.",
        ephemeral: true,
      });

    let backupNum = 1;
    while (fs.existsSync(`backup_${backupNum}.json`)) backupNum++;

    const backupData = {
      stats: playerStats,
      counter: matchCounter,
      history: matchHistory,
      decks: deckStats,
    };
    fs.writeFileSync(
      `backup_${backupNum}.json`,
      JSON.stringify(backupData, null, 2),
    );

    playerStats = {};
    matchCounter = 1;
    matchHistory = {};
    deckStats = {};
    queue = [];
    matches = {};
    saveData();

    return interaction.update({
      content: `⚠️ DATABASE HAS BEEN RESET SUCCESSFULLY. (Backup saved: \`backup_${backupNum}.json\`)`,
      embeds: [],
      components: [],
    });
  }

  if (interaction.customId.startsWith("cancel_reset_")) {
    const targetUserId = interaction.customId.split("_")[2];
    if (interaction.user.id !== targetUserId)
      return interaction.reply({
        content: "You are not allowed to decline this.",
        ephemeral: true,
      });
    return interaction.update({
      content: "Reset declined.",
      embeds: [],
      components: [],
    });
  }

  if (interaction.customId === "leave_queue") {
    let left = false;
    // Checks if they are in the 10-second pending queue and removes them
    if (pendingQueue.has(userId)) {
      pendingQueue.delete(userId);
      left = true;
    }

    const i = queue.findIndex((q) => q.id === userId);
    if (i !== -1) {
      queue.splice(i, 1);
      left = true;
    }

    if (!left) {
      return interaction.reply({ content: "Not in queue.", ephemeral: true });
    }

    return interaction.reply({ content: "Left queue.", ephemeral: true });
  }

  if (interaction.customId.startsWith("accept_")) {
    const mId = interaction.customId.split("_")[1];
    const m = matches[mId];

    if (!m) return interaction.reply({ content: "Expired.", ephemeral: true });
    if (!m.players.includes(userId))
      return interaction.reply({ content: "Not yours.", ephemeral: true });

    if (!m.accepted.includes(userId)) m.accepted.push(userId);

    if (m.accepted.length === 2) {
      clearTimeout(m.timeout);
      const readyEmbed = createBaseEmbed()
        .setTitle(`Match ${mId} Ready!`)
        .setThumbnail(client.user.displayAvatarURL())
        .setDescription(
          `────────────────────────────────────────\n\n` +
            `${formatPlayer(m.players[0])}\n**VS**\n${formatPlayer(m.players[1])}\n\n**Report winner:**\n\`!win ${mId} @winner\``,
        );
      return interaction.update({
        content: "",
        embeds: [readyEmbed],
        components: [],
      });
    }
    interaction.reply({ content: "Waiting for opponent...", ephemeral: true });
  }

  if (interaction.customId.startsWith("cancel_")) {
    const mId = interaction.customId.split("_")[1];
    const m = matches[mId];

    if (!m) return interaction.reply({ content: "Expired.", ephemeral: true });
    if (!m.players.includes(userId))
      return interaction.reply({ content: "Not yours.", ephemeral: true });

    clearTimeout(m.timeout);
    let pd = getPlayer(userId);
    pd.elo = Math.max(0, pd.elo - 15);
    saveData();

    if (m.message)
      await m.message.edit({
        content: `<@${userId}> declined (-15 Elo).`,
        embeds: [],
        components: [],
      });
    delete matches[mId];
  }
});

client.login(process.env.TOKEN);

function getPlayer(id) {
  if (!playerStats[id]) {
    playerStats[id] = {
      elo: 400,
      peakElo: 400, // Track peak elo
      wins: 0,
      losses: 0,
      placements: 0,
      placed: false,
      recentDecks: [],
      winstreak: 0,
      highestWinstreak: 0,
      autoAccept: false, // Auto-Accept defaults to false
    };
  }

  // Backwards compatibility for existing players
  if (playerStats[id].winstreak === undefined) playerStats[id].winstreak = 0;
  if (playerStats[id].highestWinstreak === undefined)
    playerStats[id].highestWinstreak = 0;
  if (playerStats[id].autoAccept === undefined)
    playerStats[id].autoAccept = false;
  // Backwards compatibility for peak elo
  if (playerStats[id].peakElo === undefined)
    playerStats[id].peakElo = playerStats[id].elo;

  // Append to old data
  return playerStats[id];
}

// IMPROVED ELO ALGORITHM (FIDE SYSTEM)
function updateElo(winnerId, loserId) {
  const winner = getPlayer(winnerId);
  const loser = getPlayer(loserId);

  const getK = (player) => {
    const totalGames = player.wins + player.losses;
    if (totalGames < 30) return 40;
    if (player.elo >= 2400) return 10;
    return 20;
  };

  const winnerK = getK(winner);
  const loserK = getK(loser);

  const expectedWinner = 1 / (1 + Math.pow(10, (loser.elo - winner.elo) / 400));
  const expectedLoser = 1 / (1 + Math.pow(10, (winner.elo - loser.elo) / 400));

  const gain = Math.round(winnerK * (1 - expectedWinner));
  const loss = Math.round(loserK * (0 - expectedLoser) * -1);

  winner.elo += gain;

  // Check if new elo is a peak elo
  if (!winner.peakElo || winner.elo > winner.peakElo) {
    winner.peakElo = winner.elo;
  }

  loser.elo -= loss;
  if (loser.elo < 0) loser.elo = 0;

  winner.wins++;
  loser.losses++;

  winner.winstreak++;
  if (winner.winstreak > winner.highestWinstreak) {
    winner.highestWinstreak = winner.winstreak;
  }
  loser.winstreak = 0;

  if (!winner.placed) {
    winner.placements++;
    if (winner.placements >= 8) winner.placed = true;
  }
  if (!loser.placed) {
    loser.placements++;
    if (loser.placements >= 8) loser.placed = true;
  }

  return { winnerGain: gain, loserLoss: loss };
}

// NEW RANK STRUCTURE
function getRank(elo) {
  if (elo >= 2400) return "Disintegrating Stud";
  if (elo >= 2200) return "Broken Stud I";
  if (elo >= 2000) return "Broken Stud II";
  if (elo >= 1800) return "Broken Stud III";
  if (elo >= 1600) return "Cosmic Stud I";
  if (elo >= 1400) return "Cosmic Stud II";
  if (elo >= 1200) return "Cosmic Stud III";
  if (elo >= 1000) return "Circle Stud I";
  if (elo >= 850) return "Circle Stud II";
  if (elo >= 700) return "Circle Stud III";
  if (elo >= 500) return "Stud I";
  if (elo >= 300) return "Stud II";
  if (elo >= 100) return "Stud III";
  return "Nascent Stud";
}

async function updateRole(member, elo) {
  const ranks = [
    { name: "Disintegrating Stud", min: 2400 },
    { name: "Broken Stud I", min: 2200 },
    { name: "Broken Stud II", min: 2000 },
    { name: "Broken Stud III", min: 1800 },
    { name: "Cosmic Stud I", min: 1600 },
    { name: "Cosmic Stud II", min: 1400 },
    { name: "Cosmic Stud III", min: 1200 },
    { name: "Circle Stud I", min: 1000 },
    { name: "Circle Stud II", min: 850 },
    { name: "Circle Stud III", min: 700 },
    { name: "Stud I", min: 500 },
    { name: "Stud II", min: 300 },
    { name: "Stud III", min: 100 },
    { name: "Nascent Stud", min: 0 },
  ];
  const guild = member.guild;

  for (let r of Object.keys(RANK_ROLES)) {
    const roleId = RANK_ROLES[r];
    if (roleId !== "YOUR_ROLE_ID_HERE" && member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId).catch(() => {});
    }
  }

  const newRank = ranks.find((r) => elo >= r.min);
  const newRoleId = RANK_ROLES[newRank.name];
  if (newRoleId && newRoleId !== "YOUR_ROLE_ID_HERE") {
    const roleObj = guild.roles.cache.get(newRoleId);
    if (roleObj) await member.roles.add(roleObj).catch(() => {});
  }
}
