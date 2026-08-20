import os from "os";
import path from "path";

export function grokHome() {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

export function sessionsRoot() {
  return path.join(grokHome(), "sessions");
}

export function configPath() {
  return path.join(grokHome(), "config.toml");
}

export function defaultProjectsRoot() {
  return process.env.GROK_WEB_PROJECTS_ROOT || path.join(os.homedir(), "projetos");
}
