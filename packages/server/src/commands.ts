import { SlashCommandBuilder } from "discord.js";

// Shared slash-command definitions, registered both at runtime (index.ts, on
// ClientReady) and by the standalone deploy-commands script. Exported as JSON
// so consumers pass them straight to REST.put({ body: commands }).
export const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Add a song to the queue and start playing")
    .addStringOption((option) =>
      option.setName("url").setDescription("YouTube URL").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("listen")
    .setDescription("Join voice channel and start the queue"),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop playing and leave voice channel"),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current song"),
  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Show the current queue"),
  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("Reset all songs to be playable again"),
].map((command) => command.toJSON());
