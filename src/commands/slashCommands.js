import { SlashCommandBuilder } from "discord.js";
import { resolveDiscordGuild } from "../channels/resolveGuild.js";

export function buildSlashCommandPayloads() {
  return [
    new SlashCommandBuilder().setName("help").setDescription("Show bridge commands and usage notes"),
    new SlashCommandBuilder()
      .setName("ask")
      .setDescription("Send a prompt into the current Codex thread")
      .addStringOption((option) =>
        option.setName("prompt").setDescription("Prompt text to send").setRequired(true)
      ),
    new SlashCommandBuilder().setName("status").setDescription("Show queue, thread, and sandbox status for this channel"),
    new SlashCommandBuilder().setName("new").setDescription("Clear the current Codex thread binding for this channel"),
    new SlashCommandBuilder()
      .setName("restart")
      .setDescription("Request a host-managed bridge restart")
      .addStringOption((option) =>
        option.setName("reason").setDescription("Optional reason recorded in the restart request").setRequired(false)
      ),
    new SlashCommandBuilder().setName("interrupt").setDescription("Interrupt the active turn in this channel"),
    new SlashCommandBuilder().setName("where").setDescription("Show runtime paths and current channel binding"),
    new SlashCommandBuilder().setName("agents").setDescription("Show configured agents and current selection"),
    new SlashCommandBuilder()
      .setName("setpath")
      .setDescription("Bind this chat to an existing repo path")
      .addStringOption((option) =>
        option.setName("path").setDescription("Absolute repo path to bind").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("approve")
      .setDescription("Approve the latest or specified pending request")
      .addStringOption((option) =>
        option.setName("id").setDescription("Approval id shown in Discord").setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("decline")
      .setDescription("Decline the latest or specified pending request")
      .addStringOption((option) =>
        option.setName("id").setDescription("Approval id shown in Discord").setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("cancel")
      .setDescription("Cancel the latest or specified pending request")
      .addStringOption((option) =>
        option.setName("id").setDescription("Approval id shown in Discord").setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName("initrepo")
      .setDescription("Create or rebind a repo for this channel under WORKSPACE_ROOT")
      .addBooleanOption((option) =>
        option.setName("force").setDescription("Rebind even if the path or channel is already in use").setRequired(false)
      ),
    new SlashCommandBuilder().setName("resync").setDescription("Rescan Codex projects and sync managed channels"),
    new SlashCommandBuilder().setName("rebuild").setDescription("Rebuild the managed channel layout from scratch")
  ].map((command) => command.toJSON());
}

export function buildCommandTextFromInteraction(interaction) {
  const getString = (name) => normalizeOption(interaction.options?.getString?.(name));
  const getBoolean = (name) => interaction.options?.getBoolean?.(name) === true;

  switch (interaction.commandName) {
    case "help":
      return "!help";
    case "ask":
      return joinCommand("!ask", getString("prompt"));
    case "status":
      return "!status";
    case "new":
      return "!new";
    case "restart":
      return joinCommand("!restart", getString("reason"));
    case "interrupt":
      return "!interrupt";
    case "where":
      return "!where";
    case "agents":
      return "!agents";
    case "setpath":
      return joinCommand("!setpath", getString("path"));
    case "approve":
      return joinCommand("!approve", getString("id"));
    case "decline":
      return joinCommand("!decline", getString("id"));
    case "cancel":
      return joinCommand("!cancel", getString("id"));
    case "initrepo":
      return getBoolean("force") ? "!initrepo force" : "!initrepo";
    case "resync":
      return "!resync";
    case "rebuild":
      return "!rebuild";
    default:
      return "";
  }
}

export async function syncSlashCommands({ discord, resolveGuild = resolveDiscordGuild, logger = console }) {
  const payloads = buildSlashCommandPayloads();
  const configuredGuildId = String(process.env.DISCORD_GUILD_ID ?? "").trim();

  try {
    const guild = await resolveGuild(discord);
    await guild.commands.set(payloads);
    return {
      scope: "guild",
      guildId: guild.id,
      count: payloads.length
    };
  } catch (error) {
    if (configuredGuildId) {
      throw error;
    }
    logger?.warn?.(`slash command registration falling back to global scope: ${error.message}`);
  }

  const application = discord.application ?? (await discord.application?.fetch().catch(() => null));
  if (!application) {
    throw new Error("Discord application is not ready for slash command registration.");
  }
  await application.commands.set(payloads);
  return {
    scope: "global",
    count: payloads.length
  };
}

function joinCommand(command, value) {
  return value ? `${command} ${value}` : command;
}

function normalizeOption(value) {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : "";
}
