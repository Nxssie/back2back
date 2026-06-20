import { REST, Routes } from "discord.js";
import { commands } from "./commands";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error("Missing DISCORD_TOKEN or DISCORD_CLIENT_ID");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

async function deployCommands() {
  try {
    console.log("🔄 Registering slash commands...");
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), {
      body: commands,
    });
    console.log("✅ Slash commands registered successfully!");
  } catch (error) {
    console.error("Error registering commands:", error);
  }
}

deployCommands();
